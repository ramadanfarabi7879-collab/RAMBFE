param (
    [Parameter(Mandatory=$true)]
    [string]$InputPath,
    [float]$Scale = 2.0,
    [string]$Language = "ar-SA",
    [int]$Rotation = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null

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

function RunOcrOnSoftwareBitmap($softwareBitmap, [float]$scaleFactor = 1.0, [float]$yOffset = 0.0, [int]$pageNumber = 1) {
    $engineAr = $null
    $engineEn = $null
    try {
        $engineAr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("ar-SA"))
    } catch {}
    try {
        $engineEn = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("en-US"))
    } catch {}

    $allRawWords = [System.Collections.Generic.List[PSCustomObject]]::new()

    # 1. التعرف على الكلمات الإنجليزية والأرقام والرموز بأعلى دقة
    if ($null -ne $engineEn) {
        $ocrTaskEn = $engineEn.RecognizeAsync($softwareBitmap)
        $resEn = AwaitTask $ocrTaskEn ([Windows.Media.Ocr.OcrResult])
        foreach ($line in $resEn.Lines) {
            foreach ($word in $line.Words) {
                $allRawWords.Add([PSCustomObject]@{
                    text = $word.Text
                    x = [math]::Round(($word.BoundingRect.X / $scaleFactor), 1)
                    y = [math]::Round(($word.BoundingRect.Y / $scaleFactor) + $yOffset, 1)
                    w = [math]::Round(($word.BoundingRect.Width / $scaleFactor), 1)
                    h = [math]::Round(($word.BoundingRect.Height / $scaleFactor), 1)
                    lang = "en"
                })
            }
        }
    }

    # 2. التعرف على الكلمات العربية والأرقام غير المكتشفة بالإنجليزية
    if ($null -ne $engineAr) {
        $ocrTaskAr = $engineAr.RecognizeAsync($softwareBitmap)
        $resAr = AwaitTask $ocrTaskAr ([Windows.Media.Ocr.OcrResult])
        foreach ($line in $resAr.Lines) {
            foreach ($word in $line.Words) {
                $text = $word.Text.Trim()
                if ([string]::IsNullOrWhiteSpace($text)) { continue }

                $curX = [math]::Round(($word.BoundingRect.X / $scaleFactor), 1)
                $curY = [math]::Round(($word.BoundingRect.Y / $scaleFactor) + $yOffset, 1)
                $curW = [math]::Round(($word.BoundingRect.Width / $scaleFactor), 1)
                $curH = [math]::Round(($word.BoundingRect.Height / $scaleFactor), 1)

                # إذا كانت الكلمة تحتوي حروفا عربية، نقبلها فورا
                if ($text -match '[\u0600-\u06FF]') {
                    $allRawWords.Add([PSCustomObject]@{
                        text = $text
                        x = $curX
                        y = $curY
                        w = $curW
                        h = $curH
                        lang = "ar"
                    })
                } else {
                    # إذا كانت الكلمة أرقاما أو كودا لاتينيا ولم يكتشفه المحرك الإنجليزي في نفس الموضع:
                    $hasEnOverlap = $false
                    foreach ($enW in $allRawWords) {
                        if ([math]::Abs($enW.x - $curX) -lt 15.0 -and [math]::Abs($enW.y - $curY) -lt 8.0) {
                            $hasEnOverlap = $true
                            break
                        }
                    }
                    if (-not $hasEnOverlap) {
                        $allRawWords.Add([PSCustomObject]@{
                            text = $text
                            x = $curX
                            y = $curY
                            w = $curW
                            h = $curH
                            lang = "ar-digits"
                        })
                    }
                }
            }
        }
    }

    # تجميع سريع في أسطر أفقية بتعقيد O(N) بدلاً من العمليات البطيئة
    $sortedWords = $allRawWords | Sort-Object y, x
    $rows = [System.Collections.Generic.List[System.Collections.Generic.List[object]]]::new()
    $currentRow = $null
    $currentY = -999.0

    foreach ($wItem in $sortedWords) {
        if ($null -eq $currentRow -or [math]::Abs($wItem.y - $currentY) -gt 10.0) {
            $currentRow = [System.Collections.Generic.List[object]]::new()
            $rows.Add($currentRow)
            $currentY = $wItem.y
        }
        $currentRow.Add($wItem)
    }

    $linesData = @()
    foreach ($row in $rows) {
        $sortedRow = $row | Sort-Object x
        $minX = ($sortedRow | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
        $minY = ($sortedRow | ForEach-Object { $_.y } | Measure-Object -Minimum).Minimum
        $maxX = ($sortedRow | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
        $maxY = ($sortedRow | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
        $lineText = ($sortedRow | ForEach-Object { $_.text }) -join " "

        $linesData += [PSCustomObject]@{
            page = $pageNumber
            text = $lineText
            x = $minX
            y = $minY
            w = [math]::Round($maxX - $minX, 1)
            h = [math]::Round($maxY - $minY, 1)
            words = @($sortedRow)
        }
    }

    return $linesData
}

function RunOcrOnImageFile($filePath) {
    $origPath = [System.IO.Path]::GetFullPath($filePath)
    if (-not (Test-Path $origPath)) {
        return @()
    }

    $scaleApplied = 1.0
    $tempPath = $null

    try {
        $srcBmp = [System.Drawing.Bitmap]::FromFile($origPath)
        if ($Rotation -eq 180) {
            $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone)
        } elseif ($Rotation -eq 90) {
            $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone)
        } elseif ($Rotation -eq 270) {
            $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone)
        }

        $w = $srcBmp.Width
        $h = $srcBmp.Height

        if ($w -lt 2400 -and $Scale -gt 1.0) {
            $scaleApplied = $Scale
            $newW = [int]($w * $scaleApplied)
            $newH = [int]($h * $scaleApplied)
            $scaledBmp = New-Object System.Drawing.Bitmap($newW, $newH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $g = [System.Drawing.Graphics]::FromImage($scaledBmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.DrawImage($srcBmp, 0, 0, $newW, $newH)
            $g.Dispose()
            $srcBmp.Dispose()

            $tempPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("ocr_scaled_" + [System.Guid]::NewGuid().ToString("N") + ".png"))
            $scaledBmp.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $scaledBmp.Dispose()
            $pathToOpen = $tempPath
        } else {
            if ($Rotation -gt 0) {
                $tempPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ("ocr_rot_" + [System.Guid]::NewGuid().ToString("N") + ".png"))
                $srcBmp.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
                $srcBmp.Dispose()
                $pathToOpen = $tempPath
            } else {
                $srcBmp.Dispose()
                $pathToOpen = $origPath
            }
        }

        $fileTask = [Windows.Storage.StorageFile]::GetFileFromPathAsync($pathToOpen)
        $storageFile = AwaitTask $fileTask ([Windows.Storage.StorageFile])

        $streamTask = $storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)
        $stream = AwaitTask $streamTask ([Windows.Storage.Streams.IRandomAccessStream])

        $decoderTask = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
        $decoder = AwaitTask $decoderTask ([Windows.Graphics.Imaging.BitmapDecoder])

        $bitmapTask = $decoder.GetSoftwareBitmapAsync()
        $softwareBitmap = AwaitTask $bitmapTask ([Windows.Graphics.Imaging.SoftwareBitmap])

        $result = RunOcrOnSoftwareBitmap $softwareBitmap $scaleApplied 0.0 1
        return $result
    } finally {
        if ($tempPath -and (Test-Path $tempPath)) {
            Remove-Item $tempPath -ErrorAction SilentlyContinue
        }
    }
}

function RunOcrOnPdfFile($pdfPath) {
    try {
        $resolvedPath = [System.IO.Path]::GetFullPath($pdfPath)
        if (-not (Test-Path $resolvedPath)) {
            return @()
        }

        $fileTask = [Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)
        $storageFile = AwaitTask $fileTask ([Windows.Storage.StorageFile])

        $pdfDocTask = [Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($storageFile)
        $pdfDoc = AwaitTask $pdfDocTask ([Windows.Data.Pdf.PdfDocument])

        if ($null -eq $pdfDoc -or $pdfDoc.PageCount -eq 0) {
            return @()
        }

        $allLines = @()
        $yCumulative = 0.0

        $pagesToProcess = [math]::Min([int]$pdfDoc.PageCount, 10)
        for ($i = 0; $i -lt $pagesToProcess; $i++) {
            try {
                $page = $pdfDoc.GetPage($i)
                $memStream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
                
                $renderOptions = New-Object Windows.Data.Pdf.PdfPageRenderOptions
                $scaleFactor = 2.5
                $targetWidth = [uint32][math]::Max(2400, [int]($page.Size.Width * $scaleFactor))
                $renderOptions.DestinationWidth = $targetWidth

                $renderTask = $page.RenderToStreamAsync($memStream, $renderOptions)
                AwaitAction $renderTask

                $decoderTask = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($memStream)
                $decoder = AwaitTask $decoderTask ([Windows.Graphics.Imaging.BitmapDecoder])

                $softwareBitmap = $null
                if ($Rotation -gt 0) {
                    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
                    if ($Rotation -eq 180) {
                        $transform.Rotation = [Windows.Graphics.Imaging.BitmapRotation]::Clockwise180Degrees
                    } elseif ($Rotation -eq 90) {
                        $transform.Rotation = [Windows.Graphics.Imaging.BitmapRotation]::Clockwise90Degrees
                    } elseif ($Rotation -eq 270) {
                        $transform.Rotation = [Windows.Graphics.Imaging.BitmapRotation]::Clockwise270Degrees
                    }
                    $bitmapTask = $decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)
                    $softwareBitmap = AwaitTask $bitmapTask ([Windows.Graphics.Imaging.SoftwareBitmap])
                } else {
                    $bitmapTask = $decoder.GetSoftwareBitmapAsync()
                    $softwareBitmap = AwaitTask $bitmapTask ([Windows.Graphics.Imaging.SoftwareBitmap])
                }

                $actualScale = $targetWidth / $page.Size.Width
                $pageLines = RunOcrOnSoftwareBitmap $softwareBitmap $actualScale $yCumulative ($i + 1)
                $allLines += $pageLines

                $yCumulative += ($page.Size.Height + 50.0)
            } catch {
                # Continue processing remaining pages
            }
        }

        return $allLines
    } catch {
        return @()
    }
}

try {
    $fullInputPath = [System.IO.Path]::GetFullPath($InputPath)
    if (-not (Test-Path $fullInputPath)) {
        Write-Output "[]"
        exit 0
    }

    $ext = [System.IO.Path]::GetExtension($fullInputPath).ToLower()
    if ($ext -eq ".pdf") {
        $lines = RunOcrOnPdfFile $fullInputPath
    } else {
        $lines = RunOcrOnImageFile $fullInputPath
    }

    $json = $lines | ConvertTo-Json -Depth 5 -Compress
    if ([string]::IsNullOrWhiteSpace($json)) {
        Write-Output "[]"
    } else {
        Write-Output $json
    }
} catch {
    Write-Output "[]"
}
