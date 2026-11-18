#!/bin/sh
# Service k3s-setup in docker-compose.yml. Runs on every `docker compose up`
# once the k3s API answers, and is idempotent:
#   1. kubeconfigs with context orbit-compose, for the host (127.0.0.1:6443)
#      and for containers (k3s:6443)
#   2. the platform manifests shared with the kind setup: namespaces, the
#      in-cluster Traefik for app Ingresses, and Orbit's RBAC
#   3. Prometheus's access: a ServiceAccount whose token and CA go to the
#      prometheus-k8s volume
set -eu

log() { echo "k3s-setup: $*"; }

src=/output/kubeconfig.yaml
i=0
until [ -s "$src" ]; do
  i=$((i + 1))
  [ "$i" -le 60 ] || { log "k3s never wrote $src" >&2; exit 1; }
  sleep 1
done

# k3s names everything "default"; Orbit only accepts the context it is told to use.
sed -e 's/: default$/: orbit-compose/' "$src" > /output/orbit-host.kubeconfig
sed -e 's#https://127.0.0.1:6443#https://k3s:6443#' /output/orbit-host.kubeconfig > /output/orbit-compose.kubeconfig
chmod 644 /output/orbit-host.kubeconfig /output/orbit-compose.kubeconfig
log "kubeconfigs written (context orbit-compose)"

k() { kubectl --kubeconfig /output/orbit-compose.kubeconfig "$@"; }

k apply -f /manifests/00-namespaces.yaml -f /manifests/10-traefik.yaml -f /manifests/50-orbit-rbac.yaml
k apply -f /setup/prometheus-access.yaml

token=''
i=0
while [ -z "$token" ]; do
  i=$((i + 1))
  [ "$i" -le 60 ] || { log "Secret orbit-system/prometheus-token never got a token" >&2; exit 1; }
  token=$(k -n orbit-system get secret prometheus-token -o jsonpath='{.data.token}' 2>/dev/null || true)
  [ -n "$token" ] || sleep 1
done
ca=$(k -n orbit-system get secret prometheus-token -o jsonpath='{.data.ca\.crt}')
printf '%s' "$token" | base64 -d > /prometheus-k8s/token
printf '%s' "$ca" | base64 -d > /prometheus-k8s/ca.crt
chmod 644 /prometheus-k8s/token /prometheus-k8s/ca.crt
log "Prometheus token written"
log "done"
