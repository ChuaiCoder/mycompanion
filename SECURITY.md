# Security policy

Please report a suspected vulnerability privately to the project maintainer
before opening a public issue. Until a public security contact is configured,
do not include API keys, private character cards, chat logs, or exploit payloads
in a public report.

Supported releases and a dedicated security contact will be published before
the first public release. Character-card samples used in reports should be
reduced to the minimum data needed to reproduce the issue.

SillyTavern JavaScript/CSS extensions execute in the application's main document,
with access to its DOM, shared state and same-origin local APIs. Installing an
extension grants it this frontend access, including access to chats and the
ability to change application data. Extension requests use normal browser
network and origin rules. The compatibility runtime does not add an iframe
sandbox or a restrictive Content Security Policy.

Electron still enables process sandboxing and context isolation and disables
Node integration. Extensions are not granted direct Node.js, Electron or arbitrary
filesystem access. The desktop service listens on loopback; secrets are encrypted
at rest. Encryption does not prevent a running extension from using APIs available
to the application. Ordinary character-card and message rendering uses HTML
sanitization; imported text alone is not an installed executable extension.

Escaping the Electron process boundary, bypassing filesystem path checks during
installation or asset access, exposing secrets through unintended API responses,
or executing scripts through ordinary sanitized content are security issues.
Report them privately. Access to the application's DOM and same-origin APIs by
an installed extension is part of the supported frontend permission model.
