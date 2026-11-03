!include "LogicLib.nsh"

; Match the application's executable name exactly. The default builder check
; searches every executable under $INSTDIR and may match an installer/helper.
; nsProcess is the Unicode native plugin bundled with electron-builder.
!macro authgateCloseExactProcess PROCESS_NAME LABEL_PREFIX

  ${LABEL_PREFIX}_check_process:
    nsProcess::_FindProcess "${PROCESS_NAME}"
    Pop $R0
    ${If} $R0 == 603
      Goto ${LABEL_PREFIX}_process_closed
    ${EndIf}
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Nao foi possivel verificar os processos do AuthGate (codigo $R0). A instalacao foi interrompida." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}

    ${IfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK ${LABEL_PREFIX}_close_process
      SetErrorLevel 2
      Quit
    ${EndIf}

  ${LABEL_PREFIX}_close_process:
    ; CloseProcess first requests window closure, then terminates only processes
    ; whose executable name matches if they have not exited after three seconds.
    nsProcess::_CloseProcess "${PROCESS_NAME}"
    Pop $R0
    Sleep 500
    nsProcess::_FindProcess "${PROCESS_NAME}"
    Pop $R0
    ${If} $R0 == 603
      Goto ${LABEL_PREFIX}_process_closed
    ${EndIf}
    ${If} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O processo ${PROCESS_NAME} continua aberto. Feche-o na aba Detalhes do Gerenciador de Tarefas e tente novamente." /SD IDCANCEL IDRETRY ${LABEL_PREFIX}_check_process
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "Nao foi possivel confirmar o encerramento do AuthGate (codigo $R0). A instalacao foi interrompida." /SD IDOK
    ${EndIf}
    SetErrorLevel 2
    Quit

  ${LABEL_PREFIX}_process_closed:
    nsProcess::_Unload
!macroend

!macro customCheckAppRunning
  Push $R0
  !insertmacro authgateCloseExactProcess "${APP_EXECUTABLE_FILENAME}" "authgate_current"
  !insertmacro authgateCloseExactProcess "AuthGate Atualizador de IP.exe" "authgate_legacy"
  Pop $R0
!macroend

; Recovery is installer-only. Never execute cleanup on user data or delete the
; previous installation: move it atomically to a sibling backup instead.
!ifndef BUILD_UNINSTALLER
Var authgateBackupDir
Var authgateRecoveredFrom
Var authgateRecoveryCode
Var authgateInstallComplete

!macro authgateInstallLog MESSAGE
  FileOpen $R9 "$TEMP\AuthGate-IP-Agent-install.log" a
  FileWrite $R9 "${MESSAGE}$\r$\n"
  FileClose $R9
!macroend

!macro customInit
  StrCpy $authgateInstallComplete "0"
  !insertmacro authgateInstallLog "Installer ${VERSION}; target=$INSTDIR"
!macroend

!macro authgateRecoverOldInstallation
  StrCpy $authgateRecoveryCode "$R0"
  !insertmacro authgateInstallLog "Previous uninstaller failed: exit=$authgateRecoveryCode; path=$uninstallerFileName; directory=$installationDir"

  ; Re-check actual processes before attempting any filesystem move.
  !insertmacro customCheckAppRunning
  GetFullPathName $R1 "$installationDir"
  GetFullPathName $R2 "$INSTDIR"
  ${If} $R1 == ""
  ${OrIf} $R1 != $R2
    Goto authgate_recovery_refused
  ${EndIf}
  ; Both a known executable and Electron's package must be present. Never move
  ; arbitrary directories based solely on an incomplete registry entry.
  ${IfNot} ${FileExists} "$R1\resources\app.asar"
    Goto authgate_recovery_refused
  ${EndIf}
  ${IfNot} ${FileExists} "$R1\AuthGate-IP-Agent.exe"
  ${AndIfNot} ${FileExists} "$R1\AuthGate Atualizador de IP.exe"
    Goto authgate_recovery_refused
  ${EndIf}

  System::Call 'kernel32::GetTickCount() i .r3'
  StrCpy $authgateBackupDir "$R1.authgate-backup-$3"
  StrCpy $authgateRecoveredFrom "$R1"
  ; Release the installer's current working directory before renaming it.
  SetOutPath "$TEMP"
  ClearErrors
  Rename "$authgateRecoveredFrom" "$authgateBackupDir"
  ${If} ${Errors}
    StrCpy $authgateBackupDir ""
    Goto authgate_recovery_refused
  ${EndIf}
  !insertmacro authgateInstallLog "Previous installation preserved at $authgateBackupDir; continuing installation."
  StrCpy $R0 0
  ClearErrors
  Return

  authgate_recovery_refused:
    !insertmacro authgateInstallLog "Recovery refused: directory could not be verified or moved. No files were deleted."
    MessageBox MB_OK|MB_ICONSTOP "A remocao da versao anterior falhou (codigo $authgateRecoveryCode). Nao foi possivel preservar a pasta com seguranca.$\r$\n$\r$\nNenhuma pasta foi apagada pela recuperacao. Envie o arquivo:$\r$\n$TEMP\AuthGate-IP-Agent-install.log" /SD IDOK
    SetErrorLevel 2
    Quit
!macroend

!macro customInstall
  StrCpy $authgateInstallComplete "1"
  !insertmacro authgateInstallLog "Installation completed; backup=$authgateBackupDir"
!macroend

Function .onGUIEnd
  ${If} $authgateBackupDir != ""
  ${AndIf} $authgateInstallComplete != "1"
    SetOutPath "$TEMP"
    ; Keep even partially extracted files for inspection, rather than deleting.
    ${If} ${FileExists} "$authgateRecoveredFrom\*.*"
      ClearErrors
      Rename "$authgateRecoveredFrom" "$authgateBackupDir.incomplete"
      ${If} ${Errors}
        !insertmacro authgateInstallLog "Rollback could not move incomplete files; original backup remains at $authgateBackupDir"
        Return
      ${EndIf}
    ${EndIf}
    ClearErrors
    Rename "$authgateBackupDir" "$authgateRecoveredFrom"
    ${If} ${Errors}
      !insertmacro authgateInstallLog "Rollback could not restore original path; original backup remains at $authgateBackupDir"
    ${Else}
      !insertmacro authgateInstallLog "Installation aborted; original directory restored."
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif
