# 视频收集 API 联调（PowerShell）。先执行 schema_video_collector.sql，再 python app.py
# 仓库根目录: .\scripts\mock_video_collector.ps1
# 若启用 API_SECRET:  $env:API_SECRET = '<与 .env 一致>'

$ErrorActionPreference = "Stop"
$Base = if ($env:BASE) { $env:BASE } else { "http://127.0.0.1:5000" }
$OpenId = if ($env:MOCK_OPENID) { $env:MOCK_OPENID } else { "oMock-{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss"), (Get-Random) }

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

Write-Host "==> BASE=$Base OPENID=$OpenId`n"

Write-Host "==> GET /health"
curl.exe -sS "$Base/health"
Write-Host "`n"

Write-Host "==> POST /participants"
$reg = @{
    wechat_openid = $OpenId
    real_name     = "MockUser"
    phone         = "13800138000"
}
Invoke-Json POST "$Base/participants" $reg
Write-Host ""

Write-Host "==> GET /participants/by_openid"
& curl.exe -sS @(Get-CurlAuthArgs) "$Base/participants/by_openid?wechat_openid=$([Uri]::EscapeDataString($OpenId))"
Write-Host "`n"

$code = if ($env:MOCK_CODE) { $env:MOCK_CODE } else { "000001" }
Write-Host "==> POST /upload/complete (participant_code=$code，请按上一步返回的 participant_code 设置 MOCK_CODE)"
$sub = @{
    participant_code = $code
    wechat_openid   = $OpenId
    source          = "h5"
    object_key      = "uploads/$code/mock-$(Get-Random).mp4"
    file_name       = "mock.mp4"
    size_bytes      = 1024
    mime            = "video/mp4"
    user_comment    = "$code+视频1"
}
Invoke-Json POST "$Base/upload/complete" $sub
Write-Host ""

Write-Host "==> GET /admin/submissions"
& curl.exe -sS @(Get-CurlAuthArgs) "$Base/admin/submissions?limit=10"
Write-Host "`n"

Write-Host "Done. 404/找不到参与者: 把 MOCK_CODE 设为 POST /participants 返回的 participant_code。401: 设置 `$env:API_SECRET"