#!/usr/bin/env bash
# Linux / NAS installer. Keep credentials in Compose's .env; never source it.
set -Eeuo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
IMAGE=ghcr.io/kronosxup/nai-workbench
trap 'printf "\n操作未完成；配置和数据已保留。请处理上面的错误后重试。\n" >&2' ERR

die() { printf '%s\n' "$*" >&2; exit 1; }
ask() { IFS= read -r -p "$1" REPLY || die '输入已结束，未继续操作。'; }
secret() {
    while true; do
        IFS= read -r -s -p "$1" REPLY || die '输入已结束，未继续操作。'
        printf '\n'
        # Single-quoted dotenv values preserve $, # and spaces literally.
        if [[ -n "$REPLY" && "$REPLY" != *"'"* && "$REPLY" != *$'\r'* ]]; then return; fi
        printf '不能为空，也请勿使用英文单引号。\n'
    done
}
compose() { docker compose --project-directory "$DIR" --env-file "$DIR/.env" "${FILES[@]}" "$@"; }
select_mode() {
    MODE=$1
    if [[ "$MODE" == stack ]]; then
        DIR="$ROOT/deploy/stack"; SERVICE=workbench
        FILES=(-f "$DIR/compose.yaml")
    else
        DIR="$ROOT"; SERVICE=frontend
        FILES=(-f "$ROOT/compose.gate.yaml")
        if [[ -f "$DIR/.env" ]] && grep -Eq '^GATE_DOCKER_NETWORK=.+$' "$DIR/.env"; then
            FILES+=(-f "$ROOT/compose.gate-network.yaml")
        fi
    fi
}
check_health() {
    printf '等待工作台启动……\n'
    local n
    for n in {1..20}; do
        if compose exec -T "$SERVICE" python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8787/api/health", timeout=3)' >/dev/null 2>&1; then
            return
        fi
        sleep 2
    done
    die "工作台还未就绪。请在 $DIR 查看容器日志；本次不算安装成功。"
}
access_help() {
    printf '\n工作台已启动。\n'
    printf '在自己的电脑另开终端，连接服务器（替换用户名和地址）：\n'
    if [[ "$MODE" == stack ]]; then
        printf '  ssh -N -L 18000:127.0.0.1:18000 -L 8787:127.0.0.1:8787 用户名@服务器地址\n'
        printf '先打开 http://127.0.0.1:18000/admin 创建 Gate Key。\n'
    else
        printf '  ssh -N -L 8787:127.0.0.1:8787 用户名@服务器地址\n'
    fi
    printf '再打开 http://127.0.0.1:8787 ，填写 Gate Key。\n'
    printf '以后更新：在此仓库目录执行 bash deploy.sh update\n'
}
install_stack() {
    select_mode stack
    local fresh_gate=0 gate_commit temp
    if [[ ! -e "$DIR/.env" ]]; then
        secret '设置 Gate 后台密码（输入不显示）：'; password=$REPLY
        secret '粘贴 NovelAI Persistent API Token（输入不显示）：'; token=$REPLY
        # Write only after both answers are complete; interrupted input leaves no partial config.
        { printf "ADMIN_PASSWORD='%s'\nNAI_TOKENS='%s'\n" "$password" "$token"
          tail -n +4 "$DIR/env.example"
        } > "$DIR/.env"
        unset password token REPLY
    else
        printf '沿用已有配置，不重新设置密码或 Token。\n'
    fi
    if [[ ! -d "$DIR/gate" ]]; then
        # Clone the upstream default branch as it exists at installation time.
        # An existing checkout is deliberately left at its current revision.
        git clone https://github.com/fangchen2003/service-tools.git "$DIR/gate"
        fresh_gate=1
    fi
    gate_commit=$(git -C "$DIR/gate" rev-parse HEAD)
    [[ "$gate_commit" =~ ^[0-9a-f]{40}$ ]] || die '无法确认 Gate 源码版本，请检查下载是否完整。'
    [[ -z "$(git -C "$DIR/gate" status --porcelain)" ]] || die 'Gate 源码有本地修改，停止自动安装以免覆盖。'
    if [[ "$fresh_gate" == 1 ]]; then
        # Save the actual revision in the image name so a later build has a
        # distinct tag and the previous image remains available for rollback.
        temp=$(mktemp "$DIR/.env.gate.XXXXXX")
        awk '!/^[[:space:]]*GATE_IMAGE[[:space:]]*=/' "$DIR/.env" > "$temp"
        printf '\nGATE_IMAGE=nai-gate:%s\n' "${gate_commit:0:12}" >> "$temp"
        mv "$temp" "$DIR/.env"
    fi
    printf '使用 Gate 源码版本：%s\n' "${gate_commit:0:12}"
    compose config --quiet
    compose pull workbench
    compose build gate
    compose up -d gate workbench
    check_health
    access_help
}
install_existing() {
    select_mode existing
    if [[ ! -e "$DIR/.env" ]]; then
        printf '填工作台容器能够访问的 Gate 地址。Gate 在同一服务器时，可用默认地址并修改端口。\n'
        ask 'Gate 地址 [http://host.docker.internal:8000]：'; url=${REPLY:-http://host.docker.internal:8000}
        [[ "$url" =~ ^https?://[a-zA-Z0-9._:-]+/?$ ]] || die '请填写不含密码、路径或查询参数的 http(s)://主机:端口 地址。'
        [[ ! "$url" =~ ^https?://(localhost|127\.0\.0\.1)(:|/|$) ]] || die '容器中的 localhost 是工作台自身。同机 Gate 请填 host.docker.internal，或 Docker 服务名。'
        ask 'Gate 的 Docker 网络名（使用容器服务名连接时填写，否则直接回车）：'; network=$REPLY
        [[ -z "$network" || "$network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die '网络名格式不正确。'
        { printf 'WORKBENCH_GATE_URL=%s\nWORKBENCH_IMAGE=%s:v0.1.0-beta.5\n' "$url" "$IMAGE"
          [[ -z "$network" ]] || printf 'GATE_DOCKER_NETWORK=%s\n' "$network"
        } > "$DIR/.env"
    else
        printf '沿用已有 .env，不改 Gate。\n'
    fi
    select_mode existing
    compose config --quiet
    compose pull frontend
    compose up -d --no-deps frontend
    check_health
    access_help
}
detect_mode() {
    if [[ -f "$ROOT/.env" && -f "$ROOT/deploy/stack/.env" ]]; then
        ask '检测到两套配置：1. 配套 Gate 安装  2. 仅工作台。选择：'
        case "$REPLY" in 1) select_mode stack;; 2) select_mode existing;; *) die '未选择配置。';; esac
    elif [[ -f "$ROOT/deploy/stack/.env" ]]; then select_mode stack
    elif [[ -f "$ROOT/.env" ]]; then select_mode existing
    else die '没有找到部署配置，请先运行 bash deploy.sh 安装。'; fi
}
update() {
    detect_mode
    local tag=${1:-beta} temp backup
    [[ "$tag" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || die '请填写镜像版本，例如 v0.1.0-beta.5。'
    printf '将工作台更新到 %s。请先让正在生成的任务结束。Gate 不会更新。\n' "$tag"
    ask '现在更新？[y/N]：'; [[ "$REPLY" == y || "$REPLY" == Y ]] || return 0
    # Pull before changing configuration, so a missing tag/network error keeps the old version selected.
    docker pull "$IMAGE:$tag"
    backup="$DIR/.env.before-update"
    cp -p "$DIR/.env" "$backup"; chmod 600 "$backup"
    temp=$(mktemp "$DIR/.env.update.XXXXXX")
    awk '!/^[[:space:]]*WORKBENCH_IMAGE[[:space:]]*=/' "$DIR/.env" > "$temp"
    printf '\nWORKBENCH_IMAGE=%s:%s\n' "$IMAGE" "$tag" >> "$temp"
    mv "$temp" "$DIR/.env"
    if ! compose config --quiet || ! compose up -d --no-deps "$SERVICE"; then
        cp -p "$backup" "$DIR/.env"
        die '更新未完成，旧配置已恢复。容器可能已更换，请查看日志；重新运行安装可按旧配置启动。'
    fi
    check_health
    printf '更新完成。刷新网页即可。旧配置保存在 %s（包含凭据，请勿分享）。\n' "$backup"
}
https_setup() {
    select_mode stack
    [[ -f "$DIR/.env" ]] || die '此向导适用于配套 Gate 安装；已有 Gate 的 HTTPS 连接见部署教程。'
    if [[ -e "$DIR/Caddyfile" ]]; then
        printf '沿用已有 Caddyfile。\n'
        FILES+=(-f "$DIR/compose.https.yaml")
        compose config --quiet
        compose up -d --no-deps caddy
        printf 'HTTPS 服务已启动，请通过原域名验证访问。\n'
        return
    fi
    printf '先将域名解析到服务器，并放行 TCP 80、443；已有反向代理时直接沿用它。\n'
    ask '填写域名（如 draw.example.com，不含 https://）：'; domain=$REPLY
    [[ "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] || die '请填有效域名。纯 IP 证书不由此向导配置。'
    sed "s/draw.example.com/$domain/" "$DIR/Caddyfile.example" > "$DIR/Caddyfile"
    FILES+=(-f "$DIR/compose.https.yaml")
    compose config --quiet
    compose up -d --no-deps caddy
    printf 'HTTPS 服务已启动，正在申请证书。稍后访问 https://%s 验证。后台仍只在本机开放。\n' "$domain"
    printf '若无法访问，请检查域名解析、80/443 端口和 Caddy 日志。\n'
}

case "${1:-}" in -h|--help)
    printf 'bash deploy.sh          安装菜单\nbash deploy.sh update [版本]  更新工作台（默认 beta）\nbash deploy.sh https    配套安装添加域名 HTTPS\n'; exit 0;; esac
command -v docker >/dev/null || die '请先安装 Docker 和 Docker Compose v2，再重新运行。'
docker compose version >/dev/null || die '需要 Docker Compose v2。'
docker info >/dev/null || die '无法连接 Docker，请先启动 Docker 并确认当前账号有权限。'
case "${1:-}" in
    update) update "${2:-beta}";;
    https) https_setup;;
    '')
        printf '1. 全新安装（Gate + 工作台）\n2. 已有 Gate，只安装工作台\n'
        ask '选择 [1/2]：'
        case "$REPLY" in
            1) command -v git >/dev/null || die '全新安装需要 Git。'; install_stack;;
            2) install_existing;;
            *) die '未选择安装方式。';;
        esac;;
    *) die '未知命令。使用 bash deploy.sh --help 查看用法。';;
esac
