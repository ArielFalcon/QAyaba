# QAyaba slim — despliegue para una red restringida

Versión de QAyaba pensada para un portátil corporativo (macOS, sin sudo) con Docker, detrás de un
proxy con inspección TLS, con Artifactory como única fuente de paquetes y con GitLab como SCM. Está
centrada en E2E y no sacrifica calidad: todo mecanismo que alimenta una decisión se conserva (pipeline
completo, stitcher FE↔BE/BE↔BE, grafo de código, mapa `context.json`, cobertura de cambio, *grounding*
del DOM, revisor independiente, Serena, engram y aprendizaje entre ejecuciones). Lo que se retira es
periferia: la publicación remota (PR/Issue), el auto-mantenimiento y el login con GitHub.

El diseño completo, sus razones y los riesgos están en
[`docs/plans/slim-poc-entorno-restringido.md`](../docs/plans/slim-poc-entorno-restringido.md).

## Qué cambia respecto a la instalación completa

| Aspecto | Completa | Slim |
|---|---|---|
| Imágenes | 2 (orquestador + agentes) | 1 imagen, 2 servicios |
| Descargas en ejecución | Serena (LS de TS/Java), OpenCode (catálogo, plugins, LSP), `npx` | **Ninguna**: todo en el build |
| DNS | Fijado a 1.1.1.1/8.8.8.8 | El del host/VPN |
| CA corporativa | No contemplada | `slim/certs/*.crt` para todos los clientes |
| Publicación | PR con auto-merge + Issues en GitHub | **Exportación local** en `slim/exports/<app>/<run>/` (parche + MR.md/ISSUE.md) |
| SCM | GitHub | Cualquier host git (GitLab): `GIT_REMOTE_BASE` + `GIT_TOKEN` |
| Login de la consola | OAuth de GitHub | Token local (`config/.api_token`) |
| Auto-mantenimiento | Sí | No |

## Requisitos

- Docker Desktop (u otro motor con `docker compose` ≥ 2.24) con **≥ 9 GB de memoria** asignados.
- Acceso de solo lectura a GitLab (un *Project/Group Access Token* con `read_repository`).
- Artifactory (o equivalente) con remotos para: imágenes Docker (mcr.microsoft.com, Docker Hub),
  npm, PyPI, Go, apt de Ubuntu (archive/security para amd64, ports para arm64), Maven Central y, si
  no se *vendorizan* a mano, genéricos para `github.com` y `download.eclipse.org`.
- Clave del LLM (OpenCode Go/Zen o un proveedor corporativo).

## Puesta en marcha

```bash
# 0. Diagnóstico de red (sin sudo): proxy visto por los contenedores, alcance a cada destino, inspección TLS
cp slim/.env.example slim/.env        # y rellena las URLs de Artifactory y los datos de GitLab/DEV
./slim/qayaba.sh preflight

# 1. CA corporativa (si el preflight muestra un emisor TLS corporativo)
./slim/qayaba.sh export-ca            # escribe slim/certs/corporate-ca.crt desde el llavero del sistema

# 2. (Opcional) Artefactos sin remoto en Artifactory: descárgalos con el navegador a slim/vendor/
#    (lista y URLs en slim/vendor/README.md). Se verifican por SHA-256 en el build.

# 3. (Opcional) LLM corporativo: copia slim/opencode.override.example.json a slim/opencode.override.json
#    y ajusta el proveedor y los modelos. Pon su clave en OPENCODE_API_KEY.

# 4. Construir (todas las descargas ocurren aquí) y arrancar
./slim/qayaba.sh build
./slim/qayaba.sh up
./slim/qayaba.sh check                # binarios, language servers y configuración: sin nada pendiente de descargar
```

## Dar de alta una aplicación

1. Crea `config/apps/<app>.yaml` a partir de `config/apps/example.yaml`:
   - `repo: "grupo/subgrupo/proyecto"` (ruta de GitLab) y `baseBranch`.
   - `services:` con los repos de los microservicios y, si los hay, sus globs de OpenAPI.
   - `dev.baseUrl` (sin `versionUrl` si DEV no expone `/version`).
   - `e2e.auth` si el login está en una web central (ver abajo).
   - `qa.shadow: false` → la decisión se **exporta** (en slim nada se publica en remoto).
2. Onboarding del stitcher. Clona e indexa **todos** los repos y propone `boundaries:`:
   ```bash
   ./slim/qayaba.sh onboard <app> grupo/front grupo/ms-pedidos grupo/ms-pagos
   ./slim/qayaba.sh onboard-status <app>      # revisa la propuesta
   ./slim/qayaba.sh onboard-confirm <app>     # escribe boundaries: en el YAML y lanza el run de contexto
   ```
   El run de contexto exporta `e2e/.qa/context.json` (el mapa FE↔BE). Súbelo con un MR (paso siguiente)
   para que las ejecuciones posteriores lo lean desde git.

## Ejecutar

```bash
./slim/qayaba.sh run <app> <sha>                                   # diff: el blast radius de un commit
./slim/qayaba.sh run <app> <sha> manual --guidance "el alta de pedidos"
./slim/qayaba.sh tui                                                # consola de terminal
open http://localhost:8080/app                                      # consola web
./slim/qayaba.sh exports <app>                                      # resultados exportados
```

Cada ejecución que decide publicar deja en `slim/exports/<app>/<run>/`:

- `files/`: los specs, el manifiesto y (en modo contexto) `context.json`;
- `changes.patch`: aplicable con `git apply --index`;
- `MR.md`: título, rama sugerida, rama destino, pasos para aplicarlo y la descripción del MR;
- `ISSUE.md`: cuando la decisión es abrir una incidencia;
- `export.json`: metadatos.

La fuente de verdad sigue siendo git: al fusionar el MR, la siguiente ejecución parte de la suite actualizada.

## Login en una web central (SSO con redirección)

Si la app redirige a un proveedor de identidad central (otro origen) y vuelve, decláralo en el YAML de
la app. Lo usan igual los tests (`authenticate()`), la captura de DOM que ancla selectores en rutas
autenticadas y el agente al explorar DEV:

```yaml
e2e:
  auth:
    loginUrl: "https://sso.banco.internal/"      # prefijo de la URL de la página de login
    passwordEntry: "text=Usuario y contraseña"   # si primero ofrece login con certificado
    successSelector: "[data-testid=user-menu]"   # visible solo con sesión iniciada (recomendado)
```

Las credenciales van en `DEV_TEST_USER`/`DEV_TEST_PASS` de `slim/.env`. El navegador automatizado no
tiene certificado de cliente: si el proveedor pide mTLS de forma opcional, continúa sin él y muestra el
formulario de usuario y contraseña (verificado contra un proveedor HTTPS que solicita certificado).
Si el proveedor **exige** certificado sin alternativa, hace falta un usuario técnico con contraseña en DEV.

## LLM corporativo

`slim/opencode.override.json` se fusiona con `agents/opencode.json` durante el build. Declara ahí el
proveedor (compatible con OpenAI) y reasigna el `model` de cada agente. El orquestador lee esa misma
configuración, así que:

- los presupuestos de prompt usan el `limit.context` que declares para cada modelo;
- los modelos de generador, revisor y chat salen de sus agentes;
- el *proposer* del stitcher usa el modelo de `qa-proposer`.

Mantén **modelos distintos** para `qa-generator` y `qa-reviewer`: la independencia del revisor
depende de ello. Tras cambiar el override: `./slim/qayaba.sh build && ./slim/qayaba.sh up`.

## Java y Maven

El *language server* de Java funciona en el modo "upstream JDTLS" de Serena: JDTLS, Lombok y el JDK
van en la imagen y no se descarga nada al abrir un `.java`. Para que resuelva dependencias de Maven
contra Artifactory, coloca un `settings.xml` con el mirror en `slim/maven/settings.xml`.

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `certificate verify failed` / `SELF_SIGNED_CERT_IN_CHAIN` en el build | Falta la CA corporativa | `./slim/qayaba.sh export-ca` y reconstruir |
| `fetch-artifact: cannot download …` | Host no permitido | Apunta su `*_BASE` a un remoto de Artifactory o vendoriza el fichero en `slim/vendor/` |
| `fetch-artifact: checksum mismatch` | Fichero distinto al fijado | Descarga exactamente la versión listada en `slim/vendor/SHA256SUMS` |
| `apt-get update` falla | Sin acceso a Ubuntu | `APT_MIRROR` (amd64) / `APT_PORTS_MIRROR` (arm64) |
| Los contenedores no resuelven hosts internos | DNS/VPN | Revisa que Docker Desktop use el DNS del sistema; añade los dominios internos a `EXTRA_NO_PROXY` |
| `authenticate(): the central login did not redirect back` | Credenciales o selectores | Revisa `DEV_TEST_*` y `e2e.auth` |
| Contenedores reiniciándose por memoria | Docker Desktop con poca RAM | Sube la memoria o baja `AGENTS_MEMORY`/`JDTLS_XMX` |
