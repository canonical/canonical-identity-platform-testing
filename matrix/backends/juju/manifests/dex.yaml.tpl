# Dex test IdP for the charmed matrix lane.
#
# Substrate identity is not baked in here. The applyable copy is rendered from
# dex.yaml.tpl plus root/local.auto.tfvars (gitignored — the same values
# terraform reads):
#
#   make render-manifests            # repo root; envsubst, no cluster contact
#   kubectl apply -f matrix/backends/juju/manifests/.rendered/
#   kubectl -n iam-matrix rollout restart deploy/dex
#
# The rendered output is gitignored: no tracked file may carry this machine's
# node IP or ingress hostname (they are substrate identity, not configuration).
# Placeholders (envsubst is restricted to exactly these two names, so the
# bcrypt hash below survives rendering). Both come from root/local.auto.tfvars:
#   NODE_IP           <- node_ip; the issuer URL uses node IP + NodePort so
#                        ONE URL is valid from both the kratos pods and the
#                        host browser (the same single-issuer problem the
#                        compose stack solves with host-resolver-rules).
#   INGRESS_HOSTNAME  <- ingress_hostname; kratos derives its oidc callback
#                        from the ingress, so the staticClient redirectURIs
#                        must match it. WebAuthn rows need the hostname
#                        form — see root/variables.tf.
#
# No dex charm exists in the platform; the charm-native piece is the
# kratos-external-idp-integrator app (provider=generic) pointing at this
# deployment, whose issuer_url is built from the same node_ip variable
# (root/main.tf). Config mirrors docker/dex/config.yml (same static test user).
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
    staticPasswords:
      - email: "dex-user@test.example"
        # bcrypt hash of "dex-password" (same as the compose stack)
        hash: "$2b$10$Y7RZKnr6UGSqVhVS7E/ScO..slLLLIjQ6WlhoggCN5gxHZKRq55ma"
        username: "Dex Test User"
        userID: "08a8684b-db88-4b73-90a9-3cd1661f5466"
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
