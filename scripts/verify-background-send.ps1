<#
.SYNOPSIS
    验证一个传输适配器在发送时会不会抢走前台窗口。

.DESCRIPTION
    这是 PLUGIN_PROMPT 第 10 节第 7 条的落地：在发送前后各取一次
    GetForegroundWindow()，两张句柄不一样就说明这个"后台"传输其实会把窗口顶到
    前面来 —— 这时它必须被标成 backgroundSend: false，插件的启动断言会拒绝它。

    为什么用前台窗口句柄而不是"看一眼微信是不是在最前面"：
      - 句柄是精确的、可以被比较的，而"最前面"要靠人的判断；
      - 它同时能抓住"抢了一下又还回去"这种最难发现的情况 —— 只要中间被抢过，
        句柄就会变（还回去也不一定还是同一个）。

    这个脚本不修改任何东西，只测并报告。

.PARAMETER BaseUrl
    协议服务的地址，例如 http://127.0.0.1:8848。

.PARAMETER Token
    Bearer token（可选）。

.PARAMETER ChatId
    发送目标。应当用白名单里那两个 ID 之一，而且自检只发给自己 —— 自检消息
    也是消息，不该发给第三个人。

.PARAMETER Text
    正文。默认是一句自检话术。

.PARAMETER Node
    node 可执行文件路径。Desktop 版 DSH 不自带 PATH 上的 node，可以用
    -Node 指定，或者设置环境变量 DSH_NODE。

.EXAMPLE
    powershell -NoProfile -File scripts/verify-background-send.ps1 `
      -BaseUrl http://127.0.0.1:8848 -Token t -ChatId wxid_example_dm

.OUTPUTS
    以 JSON 打印 { before, after, same, exitCode }，并以此决定退出码：
    0 = 前台窗口没变；1 = 变了（或脚本本身出错）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $BaseUrl,
    [string] $Token = "",
    [Parameter(Mandatory = $true)][string] $ChatId,
    [string] $Text = "自检：这条消息不应该抢走焦点。",
    [string] $Node = ""
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace Win32 -Name Foreground -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
'@

function Get-ForegroundHandle {
    # 句柄是个指针，转成十进制字符串才好比较、也才好打印。
    return [Win32.Foreground]::GetForegroundWindow().ToInt64().ToString()
}

$nodeExe = $Node
if ([string]::IsNullOrWhiteSpace($nodeExe)) { $nodeExe = $env:DSH_NODE }
if ([string]::IsNullOrWhiteSpace($nodeExe)) { $nodeExe = "node" }

$script = Join-Path $PSScriptRoot "send-once.mjs"
if (-not (Test-Path -LiteralPath $script)) {
    Write-Error "找不到 $script"
}

$arguments = @($script, "--base-url", $BaseUrl, "--chat", $ChatId, "--text", $Text)
if (-not [string]::IsNullOrWhiteSpace($Token)) { $arguments += @("--token", $Token) }

# 取句柄 -> 发送 -> 再取句柄。中间只允许发生"发送"这件事。
$before = Get-ForegroundHandle
$output = & $nodeExe @arguments 2>&1
$exitCode = $LASTEXITCODE
$after = Get-ForegroundHandle

$same = $before -eq $after
$result = [pscustomobject]@{
    before   = $before
    after    = $after
    same     = $same
    exitCode = $exitCode
    output   = ($output | Out-String).Trim()
}

$result | ConvertTo-Json -Depth 4

if (-not $same) {
    Write-Error "发送期间前台窗口发生了变化（$before -> $after）。这个传输不是后台发送，必须标记 capabilities.backgroundSend = false。"
    exit 1
}

if ($exitCode -ne 0) {
    Write-Error "发送失败（退出码 $exitCode），无法据此判断窗口行为。"
    exit 1
}

exit 0
