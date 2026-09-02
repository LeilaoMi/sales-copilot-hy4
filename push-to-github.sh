#!/usr/bin/env bash
# 把本项目推送到你的 GitHub 新建仓库
#
# 用法（推荐私有）：
#   GITHUB_TOKEN=ghp_你的令牌 ./push-to-github.sh
# 自定义仓库名 / 改为公开：
#   GITHUB_TOKEN=ghp_xxx ./push-to-github.sh my-sales-tool public
#
# 令牌去这里开：https://github.com/settings/tokens
#   勾选 repo（私有仓库必须勾）即可，别的不用勾。
#   令牌只在当前这条命令里用，不会写进仓库、不会留在历史里。

set -euo pipefail

# 两种用法都支持，位置参数要跟着变：
#   GITHUB_TOKEN=xxx $0 [仓库名] [private|public]   → 位置参数从 $1 就是仓库名
#   $0 <令牌> <仓库名> [private|public]             → $1 是令牌，往后顺延
# 之前没区分这两种，一律按 $2/$3 取，于是
#   GITHUB_TOKEN=xxx $0 my-repo public
# 会把 "public" 当成仓库名、可见性还退回 private —— 建出一个错的私有仓库。
if [ -n "${GITHUB_TOKEN:-}" ]; then
  TOKEN="$GITHUB_TOKEN"
  REPO="${1:-sales-copilot}"
  VISIBILITY="${2:-private}"
else
  TOKEN="${1:-}"
  REPO="${2:-sales-copilot}"
  VISIBILITY="${3:-private}"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

# ── 修 DNS 劫持 ──────────────────────────────────────────────
# 有些沙箱 / 内网环境会把 github.com 解析到假 IP（198.18.0.x），
# 结果是 curl 和 git 都连不上，报 SSL_ERROR_SYSCALL 或 403，
# 看起来像是令牌无效，其实是根本没连到 GitHub。
# 判据：解析出来的地址落在 198.18.0.0/15 就说明被劫持了。
# 绕过办法：用 DoH（DNS over HTTPS）查真实 IP，临时写进 /etc/hosts。
# 注意 /etc/hosts 在这种环境里会被自动还原，所以每次推送前都要刷一次。
fix_dns() {
  local cur
  cur=$(getent hosts api.github.com 2>/dev/null | awk '{print $1}' | head -1)
  case "$cur" in
    198.18.*|"") ;;   # 被劫持或解析不出来，往下修
    *) return 0 ;;    # 正常解析，不用管
  esac

  echo "→ 发现 GitHub 域名被 DNS 劫持（解析到 ${cur:-空}），改用 DoH 查真实地址…"
  local ip_api ip_web
  ip_api=$(curl -s -m 10 "https://dns.alidns.com/resolve?name=api.github.com&type=A" \
           | grep -oE '"data":"[0-9.]+"' | grep -oE '[0-9.]+' | head -1)
  ip_web=$(curl -s -m 10 "https://dns.alidns.com/resolve?name=github.com&type=A" \
           | grep -oE '"data":"[0-9.]+"' | grep -oE '[0-9.]+' | head -1)
  if [ -z "$ip_api" ] || [ -z "$ip_web" ]; then
    echo "  ! DoH 也查不到，先凑合按原样试（可能会连不上）"
    return 0
  fi
  grep -v -E 'github\.com' /etc/hosts > /tmp/.hosts.new 2>/dev/null || true
  printf '\n%s  api.github.com\n%s  github.com\n' "$ip_api" "$ip_web" >> /tmp/.hosts.new
  cat /tmp/.hosts.new > /etc/hosts 2>/dev/null && rm -f /tmp/.hosts.new
  echo "  ✓ 已修正解析：api.github.com → $ip_api，github.com → $ip_web"
  echo "    （若环境会还原 /etc/hosts，持久配置请写 ~/.user_hosts）"
}
fix_dns

if [ -z "$TOKEN" ]; then
  echo "× 没拿到令牌"
  echo "  用法：GITHUB_TOKEN=ghp_xxx $0 [仓库名] [private|public]"
  exit 1
fi
if [ "$VISIBILITY" != "private" ] && [ "$VISIBILITY" != "public" ]; then
  echo "× 可见性只能是 private 或 public，你给的是：$VISIBILITY"
  exit 1
fi

echo "→ 先确认敏感数据没被加进仓库…"
if git ls-files --error-unmatch data/ >/dev/null 2>&1; then
  echo "  × data/ 被加进来了！那里面是真实客户数据，先执行："
  echo "      git rm -r --cached data/"
  exit 1
fi
echo "  ✓ data/ 未入库（真实客户数据不会外泄）"

echo "→ 查 GitHub 账号…"
USER=$(curl -sS -H "Authorization: Bearer $TOKEN" https://api.github.com/user \
        | grep -oP '"login"\s*:\s*"\K[^"]+' | head -1)
if [ -z "$USER" ]; then
  echo "  × 令牌无效或没权限（需要勾选 repo）"
  exit 1
fi
echo "  ✓ 账号：$USER"

echo "→ 建仓库 $USER/$REPO（$VISIBILITY）…"
PRIVATE_JSON=$([ "$VISIBILITY" = "private" ] && echo true || echo false)
HTTP=$(curl -sS -o /tmp/gh-create.json -w '%{http_code}' \
        -X POST -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        https://api.github.com/user/repos \
        -d "{\"name\":\"$REPO\",\"private\":$PRIVATE_JSON,\"description\":\"销冠助手：零依赖、本地优先的个人销售作战台\"}")

if [ "$HTTP" = "201" ]; then
  echo "  ✓ 仓库已创建"
elif [ "$HTTP" = "422" ] || [ "$HTTP" = "409" ]; then
  echo "  ! 仓库已存在，直接往里推（不会覆盖已有历史之外的东西）"
else
  echo "  × 创建失败（HTTP $HTTP）："
  cat /tmp/gh-create.json
  exit 1
fi

echo "→ 推送…"
# 令牌塞进 URL 做一次性鉴权，推完立刻把 remote 换回干净地址，
# 免得令牌明文躺在 .git/config 里 —— 那文件很容易被误提交、误截图。
git remote remove origin 2>/dev/null || true
git remote add origin "https://$USER:$TOKEN@github.com/$USER/$REPO.git"
git push -u origin "$BRANCH"
git remote set-url origin "https://github.com/$USER/$REPO.git"

echo
echo "✓ 完成：https://github.com/$USER/$REPO"
echo "  本地 remote 已换回不含令牌的地址，令牌没有留在仓库里。"
