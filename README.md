# AI Memory Lab · private desktop build

Windows native CI source. The bundled ATLAS_DEMO is an independent SIMULATED dataset.
No official competition inputs, private memories, platform logs, credentials or prebuilt binaries are included.

Push build-related changes to main, or run **Actions → Windows native build → Run workflow**. A successful main build publishes its verified unsigned Windows installer and SHA-256 file in a private Release; manual runs retain a private workflow artifact for 14 days. Windows installation and real model use require separate acceptance. See [Windows build and verification](docs/windows-delivery.md).
