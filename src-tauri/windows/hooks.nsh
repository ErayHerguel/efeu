; efeu hieß früher flou. Nach der Installation (auch beim automatischen Update aus flou heraus) wird eine
; vorhandene flou-Installation still entfernt: Programmdateien, Startmenü- und Desktop-Verknüpfung, Eintrag
; unter „Apps“. Die Daten in %APPDATA%\app.flou.desktop bleiben erhalten: Der Uninstaller löscht sie nur,
; wenn auf seiner Bestätigungsseite „App-Daten löschen“ angehakt wird, und bei /S erscheint diese Seite nicht
; (tauri-bundler 2.10.1, installer.nsi, Section Uninstall). efeu übernimmt die Daten beim ersten Start.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\flou" "InstallLocation"
  ; Der Pfad steht in Anführungszeichen
  StrCpy $R9 $R8 1
  ${If} $R9 == '"'
    StrCpy $R8 $R8 -1 1
  ${EndIf}
  ${If} $R8 != ""
  ${AndIf} ${FileExists} "$R8\uninstall.exe"
    ; _?= lässt den Uninstaller an Ort und Stelle laufen, damit ExecWait auf ihn wartet
    ExecWait '"$R8\uninstall.exe" /S _?=$R8'
    Delete "$R8\uninstall.exe"
    RMDir "$R8"
  ${EndIf}
!macroend
