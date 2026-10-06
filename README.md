# Validación de cotizaciones LFH

Registro de cotizaciones y solicitudes de pago de tarjeta del Liceo Franco Hondureño, con doble firma verificada.

- Página: `https://dafadjunto-504.github.io/validacion-cotizaciones/`
- Servidor y datos: Google Apps Script, hoja de cálculo y carpeta Drive de la cuenta **daf.adjunto@liceofranco.org**

## Reglas aplicadas por el servidor

| Regla | Detalle |
|---|---|
| Identidad | Inicio de sesión Google. Solo cuentas @liceofranco.org con correo verificado. |
| Acceso | Solo las cuentas definidas en `REGISTRADORES`, `PROTESORERA`, `TESORERA`, `PRESIDENCIA` o `ADMINS`. |
| Registrar | `REGISTRADORES` (por defecto daf.adjunto y karen.barrientos) y `ADMINS`. |
| Firmar | Solo `PROTESORERA`, `TESORERA` y `PRESIDENCIA`, nunca la persona que registró la cotización. |
| Validación | Dos aprobaciones entre las tres. Un rechazo cierra la cotización. |
| Integridad | Huella SHA-256 de cada cotización y de su archivo, sello HMAC de cada firma. Una modificación hecha a mano en la hoja anula las firmas afectadas. |
| Anulación | Quien registró o un administrador, mientras la cotización no esté validada. |
| Trazabilidad | Hoja `Bitacora` con cada acción. |

## Tipos de documento

| Tipo | Folio | Qué se registra |
|---|---|---|
| Cotización | `COT-AAAA-0001` | Proveedor, objeto, monto, moneda, fecha, área y el PDF de la cotización. |
| Pago de tarjeta | `PTC-AAAA-0001` | Entidad, tarjeta (marca y últimos 4 dígitos), período, fecha de corte, líneas de gasto en lempiras y en dólares, y el escaneo de la carta firmada. |

Para un pago de tarjeta, las líneas se pegan desde Excel. Formato aceptado (columnas separadas por tabulaciones, sin encabezado):

- 7 columnas: fecha, proveedor, gasto por cuenta, valor total, cuenta contable, descripción, observación. Si la columna "gasto por cuenta" tiene un monto, ese monto se usa (caso de un cargo repartido entre dos cuentas); si contiene texto (por ejemplo DEVOLUCION), se muestra como nota.
- 6 columnas: fecha, proveedor, monto, cuenta contable, descripción, observación.

La página calcula los totales por moneda y el resumen por cuenta contable, y la constancia impresa reproduce el detalle y el resumen con el recuadro de validaciones (una casilla por cargo, con visto y nombre del firmante). Las líneas forman parte de la huella: cambiar una línea en la hoja anula las firmas.

## Correos automáticos

Registrar o firmar no envía ningún correo en el momento. Los avisos salen en dos resúmenes programados:

| Resumen | Cuándo | Para quién | Contenido |
|---|---|---|---|
| Semanal | Miércoles hacia las 7:00 | Las tres validadoras, con copia a quienes registran | Todas las cotizaciones pendientes de firma, con las nuevas marcadas y las firmas que faltan. Sin pendientes, no se envía. |
| Diario | Cada día hacia las 18:00 | Las tres validadoras y quienes registran | Las firmas registradas desde el resumen anterior, con el estado de cada cotización (validada, rechazada o 1 de 2). Sin firmas en el día, no se envía. |

Google ejecuta los envíos dentro de la hora indicada (por ejemplo entre 7:00 y 8:00).

## Contenido del repositorio

```
index.html            Página (GitHub Pages)
config.js             Dirección del servidor e ID de cliente Google (a completar)
.nojekyll             Desactiva Jekyll en GitHub Pages
apps-script/
  Code.gs             Código del servidor
  appsscript.json     Manifiesto del proyecto Apps Script
README.md             Esta guía
```

## Instalación

La instalación toma unos 30 minutos y se hace en cuatro partes, en este orden.

### 1. Servidor Apps Script (con daf.adjunto@liceofranco.org)

1. Abrir <https://script.google.com> con la cuenta daf.adjunto y crear un **Nuevo proyecto**. Nombrarlo `Validación de cotizaciones LFH`.
2. En **Configuración del proyecto** (rueda dentada), marcar **Mostrar el archivo de manifiesto "appsscript.json" en el editor**.
3. En el editor, reemplazar el contenido de `Code.gs` por el de `apps-script/Code.gs`, y el de `appsscript.json` por el de `apps-script/appsscript.json`. Guardar.
4. Elegir la función `setup` en la barra superior y pulsar **Ejecutar**. Aceptar los permisos (hoja de cálculo, Drive, correo, conexión externa).
   El registro de ejecución muestra el enlace de la hoja `Validación de cotizaciones LFH (registro)` y de la carpeta `Cotizaciones LFH (documentos)` creadas en el Drive de daf.adjunto.
5. En **Configuración del proyecto > Propiedades del script**, completar:

| Propiedad | Valor |
|---|---|
| `PROTESORERA` | Correo @liceofranco.org de la protesorera. |
| `TESORERA` | Correo @liceofranco.org de la tesorera. |
| `PRESIDENCIA` | Correo @liceofranco.org de la presidencia. |
| `REGISTRADORES` | Ya contiene `daf.adjunto@liceofranco.org, karen.barrientos@liceofranco.org`. |
| `ADMINS` | Opcional. Correos que pueden anular cualquier cotización (la cuenta propietaria ya lo es). |
| `CLIENT_ID` | Se completa en la parte 2. |
| `NOTIFICAR` | `si` (resúmenes activados) o `no`. |
| `URL_PAGINA` | Ya contiene la dirección de la página. |

   No modificar `SHEET_ID`, `FOLDER_ID`, `SECRETO` ni `PROPIETARIO`.

### 2. ID de cliente Google (con daf.adjunto@liceofranco.org)

1. Abrir <https://console.cloud.google.com> y crear un proyecto `validacion-cotizaciones`.
2. Ir a **APIs y servicios > Pantalla de consentimiento OAuth** (o **Google Auth Platform**). Tipo de usuario: **Interno**. Nombre de la aplicación: `Validación de cotizaciones LFH`. Correo de asistencia: daf.adjunto.
3. Ir a **Clientes** (o **Credenciales**) > **Crear cliente** > tipo **Aplicación web**.
   En **Orígenes de JavaScript autorizados** añadir exactamente `https://dafadjunto-504.github.io` (sin barra final). No hace falta URI de redirección.
4. Copiar el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pegarlo en la propiedad `CLIENT_ID` del script (parte 1, paso 5).
5. De vuelta en Apps Script, ejecutar la función `instalarEnvios` (crea los dos envíos programados y pide un permiso adicional).
6. Ejecutar la función `probarConfiguracion` y revisar el registro: las tres validadoras, `CLIENT_ID` y los dos envíos deben aparecer.

### 3. Publicar el servidor

1. En Apps Script: **Implementar > Nueva implementación**. Tipo: **Aplicación web**.
2. **Ejecutar como:** Yo (daf.adjunto). **Quién tiene acceso:** Cualquier usuario.
   Esto es necesario para que la página de GitHub pueda contactar el servidor. La seguridad no depende de este ajuste: cada solicitud lleva el token Google del usuario y el servidor lo verifica antes de hacer nada.
3. Copiar la **URL de la aplicación web** (termina en `/exec`).

Si la opción "Cualquier usuario" no aparece, la consola de administración de Google Workspace la tiene bloqueada: pedir al administrador que autorice las aplicaciones web de Apps Script accesibles para cualquier usuario.

### 4. Página en GitHub (cuenta dafadjunto-504)

1. Repositorio público `dafadjunto-504/validacion-cotizaciones` (ya creado).
2. **Add file > Upload files**: arrastrar todo el contenido del ZIP (`index.html`, `config.js`, `.nojekyll`, `README.md` y la carpeta `apps-script`). Commit.
3. Abrir `config.js` en GitHub, pulsar el lápiz y reemplazar los dos valores `PEGAR_AQUI` por la URL del paso 3 y el ID de cliente del paso 2. Commit.
4. **Settings > Pages > Build and deployment**: Source **Deploy from a branch**, rama `main`, carpeta `/ (root)`. Guardar.
5. Después de uno o dos minutos la página está en `https://dafadjunto-504.github.io/validacion-cotizaciones/`.

`config.js` no contiene ningún secreto: la URL del servidor y el ID de cliente son públicos por naturaleza. Los datos de las cotizaciones nunca están en GitHub, solo en el Drive de daf.adjunto.

## Prueba de funcionamiento

Hacen falta tres cuentas: la suya (o la de Karen) y dos de las tres validadoras.

1. Con la cuenta registradora: registrar una cotización de prueba con un PDF. Comprobar que no aparece casilla de firma para ella.
2. En Apps Script, ejecutar a mano `resumenSemanal`: las validadoras reciben la lista con la cotización de prueba.
3. Con una validadora: firmar y aprobar. El estado pasa a "1 de 2 firmas".
4. Con otra validadora: firmar y aprobar. El estado pasa a "Validada".
5. En Apps Script, ejecutar a mano `resumenDiario`: llega el correo con las dos firmas del día.
6. Pulsar **Imprimir constancia** y elegir "Guardar como PDF".
7. Prueba de integridad: en la hoja, cambiar a mano el monto de la cotización de prueba. Al recargar la página, la cotización aparece como "Modificada fuera del sistema" y sus firmas quedan sin efecto. Deshacer el cambio y anular la cotización de prueba.

## Mantenimiento

- **Cambiar una validadora o un registrador:** editar la propiedad correspondiente del script. Efecto inmediato, sin volver a publicar. Las firmas ya hechas conservan el cargo registrado al firmar.
- **Cambiar los horarios de envío:** modificar `HORA_SEMANAL` o `HORA_DIARIO` al inicio de `Code.gs` y volver a ejecutar `instalarEnvios`.
- **Actualizar el código del servidor:** reemplazar el contenido de `Code.gs`, guardar y ejecutar `setup` una vez (actualiza los encabezados de la hoja sin tocar los datos). Luego publicar una nueva versión como se indica abajo.
- **Modificar el código del servidor:** después de guardar `Code.gs`, ir a **Implementar > Gestionar implementaciones**, editar la implementación existente y elegir **Nueva versión**. Así la URL no cambia.
- **Copia de seguridad:** la hoja de registro puede descargarse en Excel desde Drive. El historial de versiones de la hoja muestra quién la abrió y modificó.

## Límites conocidos

- La cuenta propietaria (daf.adjunto) puede leer el `SECRETO` del script y, en teoría, fabricar un sello. Sus modificaciones quedan de todos modos en el historial de versiones de la hoja. Para una separación total, el script debería pertenecer a una cuenta que no firme ni registre.
- La sesión Google dura una hora; después la página pide volver a iniciar sesión (normalmente de forma automática).
- Archivo adjunto: 10 MB como máximo, en PDF, PNG o JPG.
