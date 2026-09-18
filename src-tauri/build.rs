fn main() {
    // Frank reads the League client process command line to obtain the LCU
    // port and authentication token. Windows may deny that access unless the
    // application runs elevated, including in debug builds.
    let execution_level = "requireAdministrator";

    let mut windows = tauri_build::WindowsAttributes::new();
    let app_manifest = format!(r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
        <requestedPrivileges>
            <requestedExecutionLevel level="{execution_level}" uiAccess="false" />
        </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#);
    windows = windows.app_manifest(&app_manifest);
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(windows)
    ).expect("failed to run build script");
}
