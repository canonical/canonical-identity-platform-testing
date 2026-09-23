# Dex test IdP for the charmed matrix lane (no dex charm exists; the
# kratos-external-idp-integrator app in root/main.tf points here).
# Rendered from this template plus root/local.auto.tfvars (gitignored):
#
#   make render-manifests            # repo root; envsubst, no cluster contact
#   kubectl apply -f matrix/backends/juju/manifests/.rendered/
#   kubectl -n iam-matrix rollout restart deploy/dex
#
# The rendered output is gitignored: no tracked file may carry this machine's
# node IP or ingress hostname. envsubst is restricted to exactly these names, so the bcrypt hashes below survive rendering:
#   NODE_IP           issuer URL = node IP + NodePort, valid from pods and host browser alike
#   INGRESS_HOSTNAME  kratos derives its oidc callback from the ingress (root/variables.tf)
# Config mirrors docker/dex/config.yml (same static test users).
apiVersion: v1
kind: ConfigMap
metadata:
  name: dex-config
  namespace: iam-matrix
data:
  config.yaml: |
    issuer: http://${NODE_IP}:30556/dex
    storage:
      type: memory
    web:
      http: 0.0.0.0:5556
    staticClients:
      - id: kratos
        name: Kratos
        secret: dex-client-secret
        redirectURIs:
          - https://${INGRESS_HOSTNAME}/self-service/methods/oidc/callback/dex
      # Second client for the providers=2 dimension (integrator app idp-dex2).
      - id: kratos2
        name: Kratos second provider
        secret: dex-client-secret-2
        redirectURIs:
          - https://${INGRESS_HOSTNAME}/self-service/methods/oidc/callback/dex2
    enablePasswordDB: true
    # All hashes are bcrypt of "dex-password" (same as the compose stack).
    staticPasswords:
      - email: "dex-user@test.example"
        hash: "$2b$10$Y7RZKnr6UGSqVhVS7E/ScO..slLLLIjQ6WlhoggCN5gxHZKRq55ma"
        username: "Dex Test User"
        userID: "08a8684b-db88-4b73-90a9-3cd1661f5466"
      # Same email as the seeded kratos password identity `link-user`: the login-time linking collision.
      - email: "link-user@test.example"
        hash: "$2b$10$Y7RZKnr6UGSqVhVS7E/ScO..slLLLIjQ6WlhoggCN5gxHZKRq55ma"
        username: "Link Test User"
        userID: "1b9c795b-ec99-4c84-a1b0-4dd2661f5467"
      # Matches the seeded `settings-link-user`, linked/unlinked from /ui/manage_connected_accounts.
      - email: "settings-link-user@test.example"
        hash: "$2b$10$Y7RZKnr6UGSqVhVS7E/ScO..slLLLIjQ6WlhoggCN5gxHZKRq55ma"
        username: "Settings Link User"
        userID: "2c8d795b-ec99-4c84-a1b0-4dd2661f5468"
      # Tenant journeys entered through dex: seeded `dex-*-tenant-user` identities carry these subjects.
      - email: "dex-single-tenant-user@test.example"
        hash: "$2b$10$Y7RZKnr6UGSqVhVS7E/ScO..slLLLIjQ6WlhoggCN5gxHZKRq55ma"
        username: "Dex Single Tenant User"
        userID: "3d9e795b-ec99-4c84-a1b0-4dd2661f5469"
      - email: "dex-multi-tenant-user@test.example"
        hash: "$2b$10$Y7RZKnr6UGSqVhVS7E/ScO..slLLLIjQ6WlhoggCN5gxHZKRq55ma"
        username: "Dex Multi Tenant User"
        userID: "4eaf795b-ec99-4c84-a1b0-4dd2661f546a"
    oauth2:
      skipApprovalScreen: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dex
  namespace: iam-matrix
  labels: { app: dex }
spec:
  replicas: 1
  selector:
    matchLabels: { app: dex }
  template:
    metadata:
      labels: { app: dex }
    spec:
      containers:
        - name: dex
          image: dexidp/dex:v2.42.0
          command: ["dex", "serve", "/etc/dex/config.yaml"]
          ports:
            - { containerPort: 5556, name: http }
          volumeMounts:
            - { name: config, mountPath: /etc/dex }
      volumes:
        - name: config
          configMap: { name: dex-config }
---
apiVersion: v1
kind: Service
metadata:
  name: dex
  namespace: iam-matrix
spec:
  type: NodePort
  selector: { app: dex }
  ports:
    - { name: http, port: 5556, targetPort: 5556, nodePort: 30556 }
