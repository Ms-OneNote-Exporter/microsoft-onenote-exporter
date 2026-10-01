# Notices

This project is distributed under the MIT licence. It is an umbrella: it contains
no copy of the work below, and depends on it at runtime.

## Bundled work

None. The three packages in the table below are installed from npm as ordinary
dependencies. None of their source is vendored into this repository or into the
Docker image built from it.

## Dependencies

| Package | Version | Licence | Role |
|---|---|---|---|
| `@msout/microsoft-webauth` | 0.1.8 | MIT | `login`, `check`, `logout` |
| `@msout/microsoft-onenote-list-notebooks` | 0.0.6 | MIT | `list` |
| `@msout/microsoft-onenote-export-notebook` | 0.3.7 | MIT | `export` |

All three are by the same authors and under the same MIT licence as this project.
They are developed in sibling repositories:

- <https://github.com/Ms-OneNote-Exporter/microsoft-webauth>
- <https://github.com/Ms-OneNote-Exporter/microsoft-onenote-list-notebooks>
- <https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook>

One file *is* duplicated on purpose: `logPaths.js` exists in all three packages
with only the package name changed. They are separately published and cannot share
source, and keeping the copies byte-identical is what stops the three from
disagreeing about where an installed copy writes its logs. It says so at the top
of each file, and it should collapse to one module if the packages are ever
merged.

## Trademarks

Microsoft, OneNote, Outlook and Microsoft 365 are trademarks of Microsoft
Corporation. This project is not affiliated with or endorsed by Microsoft. It
automates a browser session against services the user already has an account for.
