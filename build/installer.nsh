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
