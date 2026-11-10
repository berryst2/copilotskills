$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$requiredVersion = '0.25.0'

if (-not (Get-Command wiqd -ErrorAction SilentlyContinue)) {
    throw "Prepare the runner account with WIQD $requiredVersion before running this workflow."
}
$version = & wiqd --version --skill wiqd --workflow agent-ci-cd
$actualVersion = ($version -join "`n").Trim()
if ($LASTEXITCODE -ne 0 -or $actualVersion -cne $requiredVersion) {
    throw "The runner must have WIQD $requiredVersion on PATH; version probe returned '$actualVersion' (exit $LASTEXITCODE). Install the pinned release during human runner setup."
}
$text = & wiqd eula status --json --skill wiqd --workflow agent-ci-cd
if ($LASTEXITCODE -ne 0) {
    $text | Write-Host
    throw 'Unable to verify WIQD EULA status; no staging or deployment is authorized.'
}
$result = ($text -join "`n") | ConvertFrom-Json
if ($result.status -cne 'success') { throw 'WIQD EULA status did not return a success envelope.' }
if ($result.data.wiqd.state -cne 'accepted') {
    throw 'WIQD EULA acceptance is required at https://aka.ms/wiqd/eula. A human must review and accept interactively outside CI under the self-hosted runner account. CI cannot accept; do not copy or fabricate consent state.'
}
Write-Host "WIQD $requiredVersion and existing human EULA acceptance verified for this runner account."
