# Emulator helpers for manual end-to-end checks. Dot-source: . android\e2e\helper.ps1
# Needs adb from the Android SDK, a running emulator, and a debug build (WebView debugging is on only in debug).
$script:adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
# Screenshots and scratch files go to android/build/e2e (ignored by git).
$script:out = Join-Path $PSScriptRoot '..\build\e2e'
New-Item -ItemType Directory -Force $script:out | Out-Null
function Get-Ui { & $script:adb shell uiautomator dump /sdcard/ui.xml | Out-Null; [xml](& $script:adb shell cat /sdcard/ui.xml) }
function Find-Node([string]$attr, [string]$value) {
  $ui = Get-Ui
  $ui.SelectNodes("//node[@$attr='$value']") | Select-Object -First 1
}
function Tap-Node($node) {
  if (-not $node) { throw 'node not found' }
  $m = [regex]::Match($node.bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
  $x = ([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2; $y = ([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2
  & $script:adb shell input tap ([int]$x) ([int]$y)
}
function Tap-Id([string]$id) { Tap-Node (Find-Node 'resource-id' "app.nbase.android:id/$id") }
function Tap-Text([string]$t) { Tap-Node (Find-Node 'text' $t) }
function Shot([string]$name) { & $script:adb shell screencap -p /sdcard/s.png; & $script:adb pull /sdcard/s.png "$script:out\$name.png" | Out-Null }
function Text-Of([string]$id) { (Find-Node 'resource-id' "app.nbase.android:id/$id").text }
function Connect-Cdp {
  $pid2 = (& $script:adb shell pidof app.nbase.android).Trim()
  & $script:adb forward --remove-all | Out-Null
  & $script:adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid2" | Out-Null
}
function Eval-Page([string]$js) {
  $f = Join-Path $script:out 'expr.js'; [IO.File]::WriteAllText($f, $js)
  node (Join-Path $PSScriptRoot 'cdp.mjs') $f
}
function Tap-Visible([string]$t) {
  $node = (Get-Ui).SelectNodes("//node[@text='$t' or @content-desc='$t']") | Where-Object { $_.bounds -ne '[0,0][0,0]' } | Select-Object -First 1
  Tap-Node $node
}
function Type-Ascii([string]$s) {
  for ($i = 0; $i -lt $s.Length; $i += 4) { & $script:adb shell input text ($s.Substring($i, [Math]::Min(4, $s.Length - $i)).Replace(' ', '%s')); Start-Sleep -Milliseconds 250 }
}
# Taps a page element by its CSS box; `$find` is a JS expression returning the element.
function Tap-Css([string]$find) {
  $r = Eval-Page "(() => { const el = $find; const b = el.getBoundingClientRect(); return [b.left + b.width/2, b.top + b.height/2, devicePixelRatio].join(','); })()"
  $p = ($r.Trim('"')).Split(',')
  $wv = (Get-Ui).SelectNodes("//node[@class='android.webkit.WebView']") | Select-Object -First 1
  $m = [regex]::Match($wv.bounds, '\[(\d+),(\d+)\]')
  & $script:adb shell input tap ([int]([int]$m.Groups[1].Value + [double]$p[0] * [double]$p[2])) ([int]([int]$m.Groups[2].Value + [double]$p[1] * [double]$p[2]))
}
