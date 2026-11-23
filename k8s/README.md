# Kathmandu Metropolitan City (KMC) Municipal WebGIS & Field Collection Platform
## Enterprise Production Kubernetes (K8s) Architecture & Operations Manual

This directory contains the production-grade Kubernetes manifests, Kustomization, and Helm chart for deploying the **Kathmandu Metropolitan City (KMC) Municipal WebGIS & Field Data Collection Platform** at enterprise scale.

---

### 1. High-Level Architecture Overview

The system is engineered for horizontal scalability, zero-downtime rolling updates, and resilient spatial query execution under high concurrency (10,000+ simultaneous collectors and citizens).

```
                                  [ Internet / WAN ]
                                           │
                                  [ Cloudflare / DNS ]
                                           │
                    [ Ingress-Nginx Controller (SSL Termination) ]
                                           │
       ┌─────────────────┬─────────────────┼─────────────────┬─────────────────┐
       │                 │                 │                 │                 │
       ▼                 ▼                 ▼                 ▼                 ▼
   [Frontend]       [Geoportal]        [Backend]        [TileServer]       [Martin]
(Dashboard / HN)  (Public Portal)     (FastAPI)       (Raster MBTiles)   (MVT Vector)
 (2-8 Replicas)   (2-6 Replicas)   (3-10 Replicas)     (2 Replicas)     (2-6 Replicas)
       │                 │                 │                 │                 │
       └─────────────────┴─────────────────┤                 │                 │
                                           │                 │                 │
                         ┌─────────────────┴─────────────────┐                 │
                         ▼                                   ▼                 │
                   [Redis 7.4]                         [PgBouncer HA]          │
                  (MVT/PBF Cache)                    (Session Pooler)          │
                                                             │                 │
                                                             ▼                 ▼
                                              [PostgreSQL 16 + PostGIS 3.4 (StatefulSet)]
                                                    (GiST Spatial Indexes / SSD PVC)
```

---

### 2. Microservice Manifest Inventory

| File | Resource Kind | Component | Responsibility |
| :--- | :--- | :--- | :--- |
| `00-namespace.yaml` | `Namespace`, `ResourceQuota`, `LimitRange` | Cluster Governance | Namespace isolation, resource quotas (32 CPU, 64Gi RAM ceiling), default container requests. |
| `01-configmap.yaml` | `ConfigMap` | Configuration | 12-factor configuration (database hosts, tile URLs, CORS, upload limits). |
| `01-secrets-template.yaml` | `Secret` (Template) | Security | Database passwords, Redis auth, JWT signing keys, bootstrap administrative credentials. |
| `02-storage.yaml` | `PersistentVolumeClaim` | Storage Layer | Dedicated PVCs for PostGIS data (`postgres-pvc`), Redis (`redis-pvc`), raster MBTiles (`tileserver-pvc`), and uploads (`uploads-pvc`). |
| `03-postgres-statefulset.yaml` | `StatefulSet`, `Service` | Core Geodatabase | PostgreSQL 16 + PostGIS 3.4 with GiST spatial indexes, optimized memory parameters (`shared_buffers=1GB`, `work_mem=64MB`). |
| `04-pgbouncer-deployment.yaml` | `Deployment`, `Service` | Load Balancing & Pooling | PgBouncer HA pooler (2 replicas) handling 2,000+ client connections to eliminate database connection churn. |
| `05-redis-deployment.yaml` | `Deployment`, `Service` | In-Memory Cache | Redis 7.4 LRU caching for MVT vector tiles, task locking, and delta synchronization. |
| `06-backend-deployment.yaml` | `Deployment`, `Service`, `HPA`, `PDB` | REST & Spatial API | FastAPI API with 3 to 10 auto-scaled replicas (HPA triggered at 70% CPU / 80% RAM), PDB minAvailable 2. |
| `07-frontend-deployment.yaml` | `Deployment`, `Service`, `HPA` | Staff Portal | Next.js Management Dashboard, survey verification, metric house numbering. 2 to 8 auto-scaled replicas. |
| `08-geoportal-deployment.yaml` | `Deployment`, `Service`, `HPA` | Citizen Geoportal | Next.js Public Open Data Geoportal. 2 to 6 auto-scaled replicas. |
| `09-martin-deployment.yaml` | `Deployment`, `Service`, `HPA` | Vector Tile Engine | High-speed Rust-based MVT tile server streaming vector geometries directly from PostGIS at 60fps. |
| `09-tileserver-deployment.yaml` | `Deployment`, `Service` | Raster Tile Engine | Node-based TileServer-GL serving massive drone orthophotos and raster base layers. |
| `10-ingress.yaml` | `Ingress` | Edge Reverse Proxy | Ingress-Nginx path routing, WebSocket/SSE support, 1GB streaming body size, Let's Encrypt TLS. |
| `11-network-policies.yaml` | `NetworkPolicy` | Zero-Trust Security | Defense-in-depth network isolation preventing direct database access from untrusted pods or public ingress. |
| `kustomization.yaml` | `Kustomization` | Deployment Automation | Single-command deployment orchestrator for `kubectl apply -k k8s/`. |

---

### 3. Step-by-Step Deployment Guide

#### 3.1 Prerequisites
1. Kubernetes cluster version `1.28+` (managed EKS, GKE, AKS, or on-premise RKE2 / K3s).
2. `kubectl` and `helm` v3 CLI installed.
3. Ingress controller (`ingress-nginx`) and `cert-manager` running in the cluster.
4. Storage provisioner supporting `ReadWriteOnce` and `ReadWriteMany` (e.g. Ceph, OpenEBS, NFS, AWS EFS / EBS).

#### 3.2 Secret Setup
Copy the template and replace placeholder credentials with secure generated keys:
```bash
cp k8s/01-secrets-template.yaml k8s/01-secrets.yaml
# Edit k8s/01-secrets.yaml with strong passwords
```

#### 3.3 Deploy via Kustomize (One Command)
```bash
kubectl apply -k k8s/
```

#### 3.4 Deploy via Helm
```bash
helm upgrade --install kmc-gis ./k8s/helm/kmc-gis \
  --namespace kmc-gis \
  --create-namespace \
  -f ./k8s/helm/kmc-gis/values.yaml
```

---

### 4. Zero-Downtime Rolling Update & High Concurrency Verification

#### 4.1 Rolling Updates
All application deployments (`backend`, `frontend`, `geoportal`, `martin`) configure:
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```
When upgrading image tags, Kubernetes launches new pods and waits for their `/api/health` readiness probes to pass before terminating older pods. Zero active requests are dropped.

#### 4.2 Connection Pooling & Load Balancing
- **PgBouncer Session Pooling:** Prevents PostgreSQL connection exhaustion by multiplexing up to 2,000 backend worker connections across a tightly bounded pool of 50-250 database connections.
- **Asyncpg Zero Statement Caching:** `connect_args={"statement_cache_size": 0}` eliminates prepared statement naming collisions when routing through pooled connections.
- **Horizontal Pod Autoscaling (HPA):**
  - Backend automatically scales from 3 to 10 replicas when CPU exceeds 70% or memory exceeds 80%.
  - Frontend scales from 2 to 8 replicas.
  - Martin scales from 2 to 6 replicas.

---

### 5. Disaster Recovery & Backup Strategy

#### 5.1 Automated PostgreSQL / PostGIS Dump
Execute an automated snapshot of the PostGIS database:
```bash
kubectl exec -n kmc-gis statefulset/postgres -- \
  pg_dump -U kmc_user -d kmc_gis -F c -b -v -f /var/lib/postgresql/data/kmc_gis_backup_$(date +%Y%m%d_%H%M%S).dump
```

#### 5.2 Restore Procedure
```bash
kubectl exec -i -n kmc-gis statefulset/postgres -- \
  pg_restore -U kmc_user -d kmc_gis -v --clean --if-exists /var/lib/postgresql/data/kmc_gis_backup.dump
```
