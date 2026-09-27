# slim/certs — CA corporativa

Pon aquí la(s) CA raíz del proxy con inspección TLS como ficheros PEM con extensión `.crt`.
En macOS, `./slim/qayaba.sh export-ca` las exporta del llavero del sistema sin sudo.
El build las instala para todos los clientes de la imagen: apt, git, curl, npm, Node, pip, Go y Java.
Estos ficheros nunca se versionan.
