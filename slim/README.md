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
- Clave de la API de la pasarela de LLM. No hace falta para arrancar: si caduca a diario, se pega en la
  consola (ver «Clave diaria del LLM»).

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
#    y ajusta el proveedor y los modelos. La clave no se declara aquí: se pega en la consola (paso 5).

# 4. Construir (todas las descargas ocurren aquí) y arrancar
./slim/qayaba.sh build
./slim/qayaba.sh up
./slim/qayaba.sh check                # binarios, language servers y configuración: sin nada pendiente de descargar

# 5. Pega la clave de la API del LLM del día: consola web (http://localhost:8080/app, panel «agent runtime ·
#    LLM gateway») o pantalla «agent runtime» de la TUI (tecla `a`). OPENCODE_API_KEY en slim/.env es
#    opcional: la pila arranca sin ella y el agente espera la clave (ver «Clave diaria del LLM»).
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
./slim/qayaba.sh run <app> <sha|rama>                               # diff: el blast radius de un commit (se encola)
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
- `export.json`: metadatos; `skipped` lista las rutas que no se exportaron (archivos de CI, Dockerfiles o `.env`, enlaces simbólicos y cualquier cosa que no sea un archivo regular dentro del mirror).

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

## Clave diaria del LLM

La clave de la API de la pasarela de LLM caduca a diario, así que la pila **arranca sin ella**:
`OPENCODE_API_KEY` en `slim/.env` es opcional. Mientras no haya clave, el servicio de agentes queda en
espera (`needs_config`) y la consola lo muestra como «needs configuration».

1. Pega la clave del día en el panel **agent runtime · LLM gateway** de la consola web
   (`http://localhost:8080/app`, botón *Apply key*) o en la pantalla *agent runtime* de la TUI (tecla `a`).
2. El orquestador la entrega al servicio de agentes, que reinicia el proceso del agente con esa clave.
   El estado pasa a `healthy` en unos segundos.

Qué conviene tener presente:

- **Ejecución en curso.** Con una ejecución activa la clave no se aplica (la consola avisa de que hay una
  ejecución en curso): vuelve a pegarla cuando termine.
- **Clave caducada durante una ejecución.** Esa ejecución falla como `infra-error` (no es un fallo del
  código): pega la clave nueva y vuelve a lanzarla.
- **Reinicio de contenedores.** Si se reinicia el servicio de agentes (o la pila entera) la clave se
  pierde y hay que pegarla otra vez. Si solo se reinicia el orquestador, el servicio de agentes conserva
  la suya y la consola refleja su estado.
- **Dónde queda la clave.** Solo en el entorno del orquestador y del servicio de agentes y, para el
  orquestador, en `/app/.env` (permisos `0600`) dentro de su contenedor; ningún volumen la conserva, así que
  se pierde al recrearlo. No se guarda en el navegador ni en ninguna URL, y se enmascara en los mensajes de
  error del agente y en las salidas que se registran.

## LLM corporativo

`slim/opencode.override.json` se fusiona con `agents/opencode.json` durante el build. Declara ahí el
proveedor (compatible con OpenAI) y reasigna el `model` de cada agente. El orquestador lee esa misma
configuración, así que:

- los presupuestos de prompt usan el `limit.context` que declares para cada modelo;
- los modelos de generador, revisor y chat salen de sus agentes;
- el *proposer* del stitcher usa el modelo de `qa-proposer`.

Mantén **modelos distintos** para `qa-generator` y `qa-reviewer`: la independencia del revisor
depende de ello. Tras cambiar el override: `./slim/qayaba.sh build && ./slim/qayaba.sh up`.

Con un override que declara `provider`, OpenCode queda **limitado a esos proveedores**
(`enabled_providers`): ningún rol puede llamar a otro destino de LLM. La compartición de sesiones
(`share`) queda siempre desactivada. El build **falla** si `model`, `small_model` o el `model` de algún
agente no apunta a un proveedor habilitado y a un modelo declarado en su `models`; el error lista cada
clave afectada, de modo que un rol nunca llega a llamar en silencio a un proveedor inalcanzable.

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
| El panel *agent runtime* muestra «needs configuration» | No hay clave del día | Pégala (ver «Clave diaria del LLM») |
| Ejecución en `infra-error` con un mensaje de autenticación o de créditos del proveedor | La clave caducó o se agotó | Pega la clave nueva y vuelve a lanzar la ejecución |
