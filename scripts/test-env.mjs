// Tests use local fixtures, never a developer/CI machine's authenticated external proxy.
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
  delete process.env[name]; delete process.env[name.toLowerCase()];
}
