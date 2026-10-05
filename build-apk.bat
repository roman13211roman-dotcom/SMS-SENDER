@echo off
setlocal

REM Always return to the folder where this script itself is located.
REM sdkmanager (and other Android scripts) can silently change the
REM console's current directory, so we pin it explicitly before every
REM important step.
cd /d "%~dp0"

set ANDROID_HOME=C:\android-sdk
set PATH=%PATH%;%ANDROID_HOME%\cmdline-tools\latest\bin

echo.
echo === Checking Java ===
java -version 2>NUL
if errorlevel 1 (
    echo ERROR: Java not found. Install JDK 17 from https://adoptium.net/temurin/releases/?version=17 and run this file again.
    pause
    exit /b 1
)

java -version > "%TEMP%\java_ver_check.txt" 2>&1
findstr /C:"\"17." "%TEMP%\java_ver_check.txt" >NUL
if errorlevel 1 (
    echo.
    echo ERROR: Java is installed, but it is NOT version 17 ^(Gradle 8.7 needs Java 17 specifically^).
    echo Detected version:
    type "%TEMP%\java_ver_check.txt"
    echo.
    echo Download and install JDK 17 from this exact link:
    echo   https://adoptium.net/temurin/releases/?version=17
    echo During installation, make sure "Set JAVA_HOME variable" is checked.
    echo You do NOT need to uninstall any other Java version already on this PC.
    echo After installing, run this file again.
    del "%TEMP%\java_ver_check.txt" >NUL 2>&1
    pause
    exit /b 1
)
del "%TEMP%\java_ver_check.txt" >NUL 2>&1

echo.
echo === Checking Android SDK cmdline-tools ===
if not exist "%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat" (
    echo ERROR: Could not find %ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat
    echo Make sure you extracted the Command line tools to exactly this path ^(see step 2 in README^).
    pause
    exit /b 1
)

echo.
echo === Accepting Android SDK licenses ===
call sdkmanager --licenses

echo.
echo === Installing required SDK components ^(platform-tools, platform 34, build-tools 34^) ===
call sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

REM IMPORTANT: sdkmanager above may have changed the current directory.
REM Return to the project folder (where this script and gradlew.bat live)
REM before starting the build.
cd /d "%~dp0"

echo.
echo === Checking that gradlew.bat exists in this folder ===
if not exist "%~dp0gradlew.bat" (
    echo ERROR: Could not find gradlew.bat in folder %~dp0
    echo Make sure you extracted the ENTIRE sms-sender-android.zip archive
    echo and are running build-apk.bat from the folder that also contains gradlew.bat.
    pause
    exit /b 1
)

echo.
echo === Building APK ^(gradlew assembleDebug^) ===
call "%~dp0gradlew.bat" assembleDebug

if errorlevel 1 (
    echo.
    echo ERROR: Build failed. Scroll up to see the reason and send it to the developer.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   DONE! File is located here:
echo   %~dp0app\build\outputs\apk\debug\app-debug.apk
echo ========================================================
echo.
pause
