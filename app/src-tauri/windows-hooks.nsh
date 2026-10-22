; Compile-time only: capture the bytes makensis will read after Tauri patches NSS.
; __FILEDIR__ here is this hook's source directory, not the generated script's.
!define MEMORY_LAB_PACKAGER "${__FILEDIR__}\..\package-windows.mjs"
!define MEMORY_LAB_KERNEL "${__FILEDIR__}\binaries\memory-kernel-x86_64-pc-windows-msvc.exe"
!macro NSIS_HOOK_PREINSTALL
  !system 'node "${MEMORY_LAB_PACKAGER}" --capture-nsis "${MAINBINARYSRCPATH}" "${MEMORY_LAB_KERNEL}"' = 0
!macroend
