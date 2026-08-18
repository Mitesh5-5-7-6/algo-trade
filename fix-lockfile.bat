@echo off
REM Fix pnpm lockfile for Vercel deployment

echo ==================================
echo Updating pnpm lockfile...
echo ==================================

cd /d "%~dp0"
pnpm install

echo.
echo ==================================
echo Checking if lockfile was updated...
echo ==================================

git diff pnpm-lock.yaml | findstr /R "." | head -20

echo.
echo ==================================
echo Lockfile update complete!
echo ==================================
echo.
echo Next steps:
echo 1. Review the changes: git diff
echo 2. Commit the changes: git add pnpm-lock.yaml package.json ^&^& git commit -m "chore: add eslint-plugin-next and update lockfile"
echo 3. Push to GitHub: git push
echo.
pause
