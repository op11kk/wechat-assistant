# Mock API flow (Windows PowerShell). Start Flask first: python app.py
# Run from repo root: .\scripts\mock_api_curl.ps1
# If API_SECRET is set in .env:  $env:API_SECRET = '<same value>'

$ErrorActionPreference = "Stop"
$Base = if ($env:BASE) { $env:BASE } else { "http://127.0.0.1:5000" }
$SessionId = if ($env:SESSION_ID) { $env:SESSION_ID } else { "mock-{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"), (Get-Random) }

$Headers = @{ "Content-Type" = "application/json" }
if ($env:API_SECRET) {
    $Headers["Authorization"] = "Bearer $($env:API_SECRET)"
}

function Get-CurlAuthArgs {
    if ($env:API_SECRET) { return @("-H", "Authorization: Bearer $($env:API_SECRET)") }
    return @()
}

function Invoke-Json {
    param([string]$Method, [string]$Uri, $Body = $null)
    $params = @{ Uri = $Uri; Method = $Method; Headers = $Headers }
    if ($null -ne $Body) { $params["Body"] = ($Body | ConvertTo-Json -Compress -Depth 10) }
    try {
        $r = Invoke-WebRequest @params -UseBasicParsing
        Write-Host "HTTP $($r.StatusCode)"
        if ($r.Content) { $r.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10 }
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            Write-Host "HTTP $([int]$resp.StatusCode)"
            Write-Host $reader.ReadToEnd()
        } else { throw $_ }
    }
}

Write-Host "==> BASE=$Base SESSION_ID=$SessionId`n"

Write-Host "==> GET /health"
& curl.exe -sS @(Get-CurlAuthArgs) "$Base/health"
Write-Host "`n"

Write-Host "==> POST /sessions"
$sessionBody = @{
    session_id           = $SessionId
    user_selected_mode   = "Lite"
    capture_mode         = "Lite"
    start_time           = "2026-04-02T10:00:00Z"
    device_model         = "MockDevice"
    ios_version          = "18.0"
    app_version          = "1.0.0-mock"
    upload_status        = "not_uploaded"
}
Invoke-Json POST "$Base/sessions" $sessionBody
Write-Host ""

Write-Host "==> POST /upload_sensor"
$one = @{
    session_id   = $SessionId
    sensor_type  = "acc"
    x            = 0.01
    y            = -0.02
    z            = 9.81
    timestamp    = "2026-04-02T10:00:01.000Z"
}
Invoke-Json POST "$Base/upload_sensor" $one
Write-Host ""

Write-Host "==> POST /upload_sensor_batch"
$batch = @{
    items = @(
        @{
            session_id = $SessionId
            sensor_type = "gyro"
            x = 0.001; y = 0.002; z = -0.003
            timestamp = "2026-04-02T10:00:02.000Z"
        },
        @{
            session_id = $SessionId
            sensor_type = "acc"
            x = 0; y = 0; z = 1
            timestamp = "2026-04-02T10:00:03.000Z"
        }
    )
}
Invoke-Json POST "$Base/upload_sensor_batch" $batch
Write-Host ""

Write-Host "==> GET /sessions"
& curl.exe -sS @(Get-CurlAuthArgs) "$Base/sessions"
Write-Host "`n"

$enc = [Uri]::EscapeDataString($SessionId)
$samplesUrl = "$Base/sessions/$enc/samples?limit=10"
Write-Host "==> GET /sessions/.../samples"
& curl.exe -sS @(Get-CurlAuthArgs) $samplesUrl
Write-Host "`n"

Write-Host "==> PATCH /sessions/..."
$patch = @{ upload_status = "uploading"; total_imu_samples = 3; duration_ms = 5000 }
Invoke-Json PATCH "$Base/sessions/$enc" $patch
Write-Host ""

Write-Host "==> DELETE /sessions/..."
& curl.exe -sS -w "`nHTTP %{http_code}`n" @(Get-CurlAuthArgs) -X DELETE "$Base/sessions/$enc"
Write-Host ""

Write-Host 'Done. 503: apply schema_extras.sql (session_stats view). 401: set $env:API_SECRET to match .env'
