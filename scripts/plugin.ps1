param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [switch]$Provision,
    [switch]$CreateNewApp,
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
if (Test-Path -LiteralPath $ProjectPath) { throw "Use a new staging directory: $ProjectPath" }
if ($CreateNewApp -and -not $Provision) { throw 'CreateNewApp requires Provision.' }
if ($Publish -and -not $Provision) { throw 'Publish requires Provision.' }

& (Join-Path $PSScriptRoot 'check-wiqd.ps1')

function Invoke-Wiqd([string[]]$Arguments) {
    $text = & wiqd @Arguments --json --skill wiqd --workflow plugin
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $text | Write-Host
        if ($code -eq 3) {
            throw 'WIQD is blocked by human EULA consent. Review https://aka.ms/wiqd/eula and prepare the runner account interactively outside CI. No automatic acceptance or retry is permitted.'
        }
        throw "WIQD failed with exit code $code. Stop; do not automatically retry provisioning."
    }
    $result = ($text -join "`n") | ConvertFrom-Json
    if ($result.status -cne 'success') { throw 'WIQD did not return a success envelope.' }
    return $result
}

$text = & node (Join-Path $PSScriptRoot 'skills.mjs') discover
if ($LASTEXITCODE -ne 0) { throw 'Skill source checks failed.' }
$skills = ($text -join "`n") | ConvertFrom-Json
New-Item -ItemType Directory -Path $ProjectPath | Out-Null
$template = Join-Path $root 'banking-skills'
foreach ($file in @('wiqd.plugin.json', 'm365agents.yml')) {
    Copy-Item -LiteralPath (Join-Path $template $file) -Destination $ProjectPath
}
Copy-Item -LiteralPath (Join-Path $template 'appPackage') -Destination $ProjectPath -Recurse
New-Item -ItemType Directory -Path (Join-Path $ProjectPath 'env') | Out-Null
Copy-Item -LiteralPath (Join-Path $template 'env\.env.dev') -Destination (Join-Path $ProjectPath 'env')

foreach ($skill in $skills) {
    Invoke-Wiqd @('plugin', 'add', 'skill', '--name', $skill.name, '--folder', $ProjectPath) | Out-Null
    $destination = Join-Path $ProjectPath "appPackage\skills\$($skill.name)"
    foreach ($file in $skill.files) {
        $target = Join-Path $destination $file
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        Copy-Item -LiteralPath (Join-Path $skill.folder $file) -Destination $target
    }
}

if ($Provision) {
    if ($env:CI_ENABLED -cne 'true') { throw 'CI_ENABLED must be exactly true.' }
    if (Test-Path Env:M365_REFRESH_TOKEN) { throw 'Remove M365_REFRESH_TOKEN; this pipeline uses username/password.' }
    foreach ($name in @('M365_ACCOUNT_NAME', 'M365_ACCOUNT_PASSWORD', 'PLUGIN_DEVELOPER_NAME',
        'PLUGIN_WEBSITE_URL', 'PLUGIN_PRIVACY_URL', 'PLUGIN_TERMS_URL')) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            throw "Configure $name before provisioning."
        }
    }
    foreach ($name in @('PLUGIN_WEBSITE_URL', 'PLUGIN_PRIVACY_URL', 'PLUGIN_TERMS_URL')) {
        $uri = [uri][Environment]::GetEnvironmentVariable($name)
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $uri.Host -eq 'www.example.com') {
            throw "$name must be your real HTTPS URL."
        }
    }
    $stateNames = @('TEAMS_APP_ID', 'M365_TITLE_ID', 'M365_APP_ID')
    if ($CreateNewApp) {
        foreach ($name in $stateNames) {
            if ([Environment]::GetEnvironmentVariable($name)) { throw "Remove $name when explicitly creating a new app." }
        }
    } else {
        foreach ($name in $stateNames) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]') {
                throw "Configure $name from the previous provisioning receipt, or explicitly choose create_new_app."
            }
            Add-Content -LiteralPath (Join-Path $ProjectPath 'env\.env.dev') -Value "$name=$value"
        }
    }
    $manifestPath = Join-Path $ProjectPath 'appPackage\manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.developer.name = $env:PLUGIN_DEVELOPER_NAME
    $manifest.developer.websiteUrl = $env:PLUGIN_WEBSITE_URL
    $manifest.developer.privacyUrl = $env:PLUGIN_PRIVACY_URL
    $manifest.developer.termsOfUseUrl = $env:PLUGIN_TERMS_URL
    $manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $manifestPath -Encoding utf8
}

Invoke-Wiqd @('plugin', 'validate', '--mode', 'source', '--path', $ProjectPath, '--env', 'dev') | Out-Null
Write-Host "Source checks passed for $($skills.Count) skills. WIQD source mode is not full skill/package validation."
if (-not $Provision) { return }

Invoke-Wiqd @('plugin', 'provision', '--path', $ProjectPath, '--env', 'dev') | Out-Null
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$state = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $ProjectPath 'env\.env.dev')) {
    if ($line -match '^(TEAMS_APP_ID|M365_TITLE_ID|M365_APP_ID)=(.+)$') {
        $state[$Matches[1]] = $Matches[2]
    }
}
foreach ($name in $stateNames) {
    if (-not $state[$name]) { throw "Provision did not persist $name." }
}
$state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dist 'provisioning-ids.json') -Encoding utf8
Invoke-Wiqd @('plugin', 'validate', '--mode', 'source', '--path', $ProjectPath, '--env', 'dev') | Out-Null
$zip = Join-Path $dist 'banking-skills.zip'
Invoke-Wiqd @('plugin', 'package', '--path', $ProjectPath, '--env', 'dev', '--output', $zip) | Out-Null
& node (Join-Path $PSScriptRoot 'skills.mjs') verify $zip
if ($LASTEXITCODE -ne 0) { throw 'Final ZIP content verification failed.' }
Get-FileHash -LiteralPath $zip -Algorithm SHA256 | Select-Object Hash |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dist 'checksum.json') -Encoding utf8

if ($Publish) {
    Invoke-Wiqd @('plugin', 'validate', '--mode', 'package', '--package-file', $zip,
        '--path', $ProjectPath, '--env', 'dev') | Out-Null
    $publication = Invoke-Wiqd @('plugin', 'publish', '--path', $ProjectPath, '--env', 'dev')
    @{
        status = 'submitted_for_admin_approval'
        environment = 'dev'
        correlationId = $publication.correlationId
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dist 'publication-receipt.json') -Encoding utf8
    Write-Host 'Plugin submitted to the organization catalog for tenant administrator approval; it is not yet approved.'
}
