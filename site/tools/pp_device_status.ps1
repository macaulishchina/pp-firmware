# Read-only probe. Reuse Windows' serial stack and close the port after one sample.
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ports = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    $_.InstanceId -like 'USB\VID_303A&PID_1001&MI_00\*' -and $_.FriendlyName -match '\((COM[0-9]+)\)'
})
if ($ports.Count -ne 1) {
    Write-Output 'Expected one connected Espressif USB serial interface. Wake PP and check the data cable.'
    exit 3
}
$ports[0].FriendlyName -match '\((COM[0-9]+)\)' | Out-Null
$port = [IO.Ports.SerialPort]::new($Matches[1],115200,'None',8,'One')
$port.DtrEnable = $false
$port.RtsEnable = $false
$port.ReadTimeout = 500
$port.WriteTimeout = 1000
$port.NewLine = [string][char]10
try {
    $port.Open()
    $port.WriteLine('pp.status')
    $until = [DateTime]::UtcNow.AddSeconds(4)
    while ([DateTime]::UtcNow -lt $until) {
        try { $line = $port.ReadLine() } catch [TimeoutException] { continue }
        $start = $line.IndexOf('{"app":')
        if ($start -lt 0) { continue }
        try { $status = $line.Substring($start) | ConvertFrom-Json } catch { continue }
        if ($status.app -ne 'PA-Terminal') { continue }
        $status | Select-Object app,version,elf_sha256,protocol,connected,wake_cause,heap,largest,minimum,cache_ready,cache_stack_min_free | ConvertTo-Json -Compress
        exit 0
    }
    Write-Output 'No pp.status response.'
    exit 4
} catch {
    Write-Output $_.Exception.Message
    exit 5
} finally {
    $port.Dispose()
}
