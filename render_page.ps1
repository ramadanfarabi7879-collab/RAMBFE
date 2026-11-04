Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime] | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]

function AwaitTask($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}
function AwaitAction($WinRtAction) {
    $netTask = $asAction.Invoke($null, @($WinRtAction))
    $netTask.Wait(-1) | Out-Null
}

$pdfPath = (Get-ChildItem -Path "C:\Users\PH\Downloads" -Filter "*camscanner*.pdf")[0].FullName
$storageFile = AwaitTask ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
$pdfDoc = AwaitTask ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($storageFile)) ([Windows.Data.Pdf.PdfDocument])
$page = $pdfDoc.GetPage(0)

$outImg = "C:\Users\PH\.gemini\antigravity\scratch\invoice-matcher-app\temp\user_camscanner_page1.png"
if (Test-Path $outImg) { Remove-Item $outImg }
$newFile = New-Item -Path $outImg -ItemType File -Force

$outStorageFile = AwaitTask ([Windows.Storage.StorageFile]::GetFileFromPathAsync($newFile.FullName)) ([Windows.Storage.StorageFile])
$stream = AwaitTask ($outStorageFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])

$renderOptions = New-Object Windows.Data.Pdf.PdfPageRenderOptions
# render at higher resolution
$renderOptions.DestinationWidth = [uint32]($page.Size.Width * 2)
$renderOptions.DestinationHeight = [uint32]($page.Size.Height * 2)

$renderTask = $page.RenderToStreamAsync($stream, $renderOptions)
AwaitAction $renderTask
$stream.Dispose()

Write-Output "SUCCESS: $outImg"
