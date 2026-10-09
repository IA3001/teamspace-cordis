#!/usr/bin/env bash
# smoke.sh —— 端到端冒烟测试（一条命令验证核心链路，2026-10-01）。
#
# 覆盖：healthz → 注册/登录（cookie）→ me → 会话清单 → 发消息（cookie 身份注入）
#       → 时间线回读 → 实时链路依赖的 /api/auth 闭环。
# 用法：./scripts/smoke.sh            # 需要服务已启动（npm start）
set -uo pipefail
source "$(dirname "$0")/env.sh"
set +e

HOST="$APP_HOST"; [ "$HOST" = "0.0.0.0" ] && HOST=127.0.0.1
BASE="http://${HOST}:${APP_PORT}"
JAR="$(mktemp)"
U="smoke_$(date +%s)"
PASS=0; FAIL=0
ok()   { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }

printf '冒烟测试：%s\n' "$BASE"

# 1. 健康检查
curl -sf -m 5 "$BASE/healthz" | grep -q '"ok":true' && ok "healthz" || bad "healthz"

# 2. 注册（已存在也算过 —— 幂等重跑）
code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$U\",\"password\":\"smoke-pass-1\"}")"
{ [ "$code" = "201" ] || [ "$code" = "409" ]; } && ok "register（$code）" || bad "register（$code）"

# 3. 登录 + cookie
login="$(curl -s -m 5 -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"$U\",\"password\":\"smoke-pass-1\"}")"
echo "$login" | grep -q '"kind":"human"' && ok "login" || { bad "login：$login"; }

# 4. me（cookie 身份注入闭环）
curl -sf -m 5 -b "$JAR" "$BASE/api/auth/me" | grep -q "$U" && ok "me（cookie 注入）" || bad "me"

# 5. 会话清单（取第一个 open 会话；没有则跳过发言验证）
sid="$(curl -sf -m 5 -b "$JAR" "$BASE/api/sessions" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    try{const s=JSON.parse(d).find(x=>x.status==="open");console.log(s?s.id:"")}catch{console.log("")}})')"
if [ -n "$sid" ]; then
  ok "sessions（会话 $sid）"
  # 6. 发消息（直达时间线；未登录应 401 的对照也验一下）
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "$BASE/api/sessions/$sid/messages" \
    -H 'Content-Type: application/json' -d '{"text":"x"}')"
  [ "$code" = "401" ] && ok "未登录发言被拒（401）" || bad "未登录发言期望 401，实际 $code"
  r="$(curl -s -m 5 -b "$JAR" -X POST "$BASE/api/sessions/$sid/messages" \
    -H 'Content-Type: application/json' -d '{"text":"[smoke] 端到端冒烟消息"}')"
  echo "$r" | grep -q '"error"' && bad "send：$r" || ok "send"
  sleep 1
  curl -sf -m 5 -b "$JAR" "$BASE/api/sessions/$sid/events" | grep -q '\[smoke\]' \
    && ok "时间线回读含冒烟消息" || bad "时间线回读"
else
  printf '  · 无 open 会话，跳过发言/回读验证（先在页面建一个会话）\n'
fi

# 9. @AI 真模型防回归（D2）：@需求分析师 提问 → 60s 内等【真模型】回复。
#    模型未配置时打印跳过（占位留痕也算链路通）。
if [ -n "$sid" ]; then
  curl -s -o /dev/null -m 5 -b "$JAR" -X POST "$BASE/api/sessions/$sid/messages" \
    -H 'Content-Type: application/json' -d '{"text":"@需求分析师 冒烟防回归：请只回复四个字母 SMOKE"}'
  hit=0
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf -m 5 -b "$JAR" "$BASE/api/sessions/$sid/events" | grep -q '【真模型】'; then hit=1; break; fi
    curl -sf -m 5 -b "$JAR" "$BASE/api/sessions/$sid/events" | grep -q '【占位】' && { printf '  · 模型未配置（占位留痕链路通）\n'; hit=1; break; }
  done
  [ "$hit" = "1" ] && ok "@AI 链路（真模型或占位留痕）" || bad "@AI 链路 60s 无回应"
fi

rm -f "$JAR"
echo
if [ "$FAIL" -eq 0 ]; then printf '✓ 冒烟通过（%s 项）\n' "$PASS"
else printf '✗ 冒烟失败（过 %s / 挂 %s）\n' "$PASS" "$FAIL"; exit 1; fi
