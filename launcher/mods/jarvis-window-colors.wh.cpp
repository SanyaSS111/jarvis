// ==WindhawkMod==
// @id              jarvis-window-colors
// @name            J.A.R.V.I.S. Window Colors
// @description     Dark navy title bars, a cyan window border and light caption text for every window
// @version         1.0
// @author          J.A.R.V.I.S. launcher (based on "Windows 11 Custom Title Bar Colours" by the Windhawk community)
// @include         *
// @exclude         *\steamapps\common\*
// @exclude         *\Epic Games\*
// @exclude         *\Riot Games\*
// @exclude         *\Battle.net\*
// @exclude         *\EA Games\*
// @exclude         *\Electronic Arts\*
// @exclude         *\Ubisoft\*
// @exclude         *\XboxGames\*
// @exclude         *\EasyAntiCheat*
// @exclude         *\BattlEye\*
// @architecture    x86-64
// @compilerOptions -ldwmapi
// ==/WindhawkMod==
// Source code is published under The GNU General Public License v3.0.

// ==WindhawkModReadme==
/*
# J.A.R.V.I.S. Window Colors
Sets, through the documented DWM window attributes (Windows 11), for every window:
the caption colour, the border colour and the caption text colour, with separate
values for active and inactive windows. Colours are `#RRGGBB`.
Game folders are excluded so anti-cheat protected games are never touched.
*/
// ==/WindhawkModReadme==

// ==WindhawkModSettings==
/*
- darkMode: true
  $name: Immersive dark mode for title bars
- activeCaption: "#0A1B25"
  $name: Active title bar
- inactiveCaption: "#06111A"
  $name: Inactive title bar
- activeBorder: "#5CE1FF"
  $name: Active window border
- inactiveBorder: "#1E4A58"
  $name: Inactive window border
- activeText: "#CFF6FF"
  $name: Active caption text
- inactiveText: "#7C9DB0"
  $name: Inactive caption text
*/
// ==/WindhawkModSettings==

#include <dwmapi.h>
#include <windhawk_api.h>

#ifndef DWMWA_BORDER_COLOR
#define DWMWA_BORDER_COLOR 34
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif

struct {
    BOOL darkMode;
    COLORREF activeCaption, inactiveCaption, activeBorder, inactiveBorder, activeText, inactiveText;
} g_settings;

// "#RRGGBB" -> COLORREF (0x00BBGGRR).
static COLORREF ParseColor(PCWSTR name, COLORREF fallback) {
    PCWSTR s = Wh_GetStringSetting(name);
    COLORREF result = fallback;
    if (s && s[0] == L'#' && wcslen(s) >= 7) {
        unsigned int v = wcstoul(s + 1, nullptr, 16);
        result = RGB((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
    }
    Wh_FreeStringSetting(s);
    return result;
}

static void LoadSettings() {
    g_settings.darkMode = Wh_GetIntSetting(L"darkMode");
    g_settings.activeCaption = ParseColor(L"activeCaption", RGB(0x0A, 0x1B, 0x25));
    g_settings.inactiveCaption = ParseColor(L"inactiveCaption", RGB(0x06, 0x11, 0x1A));
    g_settings.activeBorder = ParseColor(L"activeBorder", RGB(0x5C, 0xE1, 0xFF));
    g_settings.inactiveBorder = ParseColor(L"inactiveBorder", RGB(0x1E, 0x4A, 0x58));
    g_settings.activeText = ParseColor(L"activeText", RGB(0xCF, 0xF6, 0xFF));
    g_settings.inactiveText = ParseColor(L"inactiveText", RGB(0x7C, 0x9D, 0xB0));
}

// Real top-level windows only (menus, tooltips and child windows are left alone).
static BOOL IsValidWindow(HWND hWnd) {
    if (!IsWindow(hWnd) || GetAncestor(hWnd, GA_ROOT) != hWnd) return FALSE;
    LONG_PTR style = GetWindowLongPtr(hWnd, GWL_STYLE);
    return (style & WS_CAPTION) == WS_CAPTION || (style & WS_THICKFRAME) == WS_THICKFRAME;
}

static void Apply(HWND hWnd, BOOL active) {
    if (!IsValidWindow(hWnd)) return;
    DwmSetWindowAttribute(hWnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &g_settings.darkMode, sizeof(BOOL));
    COLORREF caption = active ? g_settings.activeCaption : g_settings.inactiveCaption;
    COLORREF border = active ? g_settings.activeBorder : g_settings.inactiveBorder;
    COLORREF text = active ? g_settings.activeText : g_settings.inactiveText;
    DwmSetWindowAttribute(hWnd, DWMWA_CAPTION_COLOR, &caption, sizeof(caption));
    DwmSetWindowAttribute(hWnd, DWMWA_BORDER_COLOR, &border, sizeof(border));
    DwmSetWindowAttribute(hWnd, DWMWA_TEXT_COLOR, &text, sizeof(text));
}

static void Reset(HWND hWnd) {
    if (!IsValidWindow(hWnd)) return;
    const COLORREF def = DWMWA_COLOR_DEFAULT;
    DwmSetWindowAttribute(hWnd, DWMWA_CAPTION_COLOR, &def, sizeof(def));
    DwmSetWindowAttribute(hWnd, DWMWA_BORDER_COLOR, &def, sizeof(def));
    DwmSetWindowAttribute(hWnd, DWMWA_TEXT_COLOR, &def, sizeof(def));
}

static void OnMessage(HWND hWnd, UINT uMsg, WPARAM wParam) {
    switch (uMsg) {
        case WM_NCACTIVATE:
            Apply(hWnd, (BOOL)wParam);
            break;
        case WM_ACTIVATE:
            Apply(hWnd, LOWORD(wParam) != WA_INACTIVE);
            break;
        case WM_DWMCOLORIZATIONCOLORCHANGED:
            Apply(hWnd, GetForegroundWindow() == hWnd);
            break;
    }
}

using DefProc_t = LRESULT(WINAPI*)(HWND, UINT, WPARAM, LPARAM);
DefProc_t DefWindowProcW_orig, DefWindowProcA_orig, DefDlgProcW_orig, DefDlgProcA_orig;

LRESULT WINAPI DefWindowProcW_hook(HWND h, UINT m, WPARAM w, LPARAM l) { LRESULT r = DefWindowProcW_orig(h, m, w, l); OnMessage(h, m, w); return r; }
LRESULT WINAPI DefWindowProcA_hook(HWND h, UINT m, WPARAM w, LPARAM l) { LRESULT r = DefWindowProcA_orig(h, m, w, l); OnMessage(h, m, w); return r; }
LRESULT WINAPI DefDlgProcW_hook(HWND h, UINT m, WPARAM w, LPARAM l) { LRESULT r = DefDlgProcW_orig(h, m, w, l); OnMessage(h, m, w); return r; }
LRESULT WINAPI DefDlgProcA_hook(HWND h, UINT m, WPARAM w, LPARAM l) { LRESULT r = DefDlgProcA_orig(h, m, w, l); OnMessage(h, m, w); return r; }

static BOOL CALLBACK ApplyEnum(HWND hWnd, LPARAM pid) {
    DWORD wPid = 0;
    GetWindowThreadProcessId(hWnd, &wPid);
    if (wPid == (DWORD)pid) Apply(hWnd, GetForegroundWindow() == hWnd);
    return TRUE;
}

static BOOL CALLBACK ResetEnum(HWND hWnd, LPARAM pid) {
    DWORD wPid = 0;
    GetWindowThreadProcessId(hWnd, &wPid);
    if (wPid == (DWORD)pid) Reset(hWnd);
    return TRUE;
}

BOOL Wh_ModInit() {
    LoadSettings();
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    if (!user32) user32 = LoadLibraryW(L"user32.dll");
    Wh_SetFunctionHook((void*)GetProcAddress(user32, "DefWindowProcW"), (void*)DefWindowProcW_hook, (void**)&DefWindowProcW_orig);
    Wh_SetFunctionHook((void*)GetProcAddress(user32, "DefWindowProcA"), (void*)DefWindowProcA_hook, (void**)&DefWindowProcA_orig);
    Wh_SetFunctionHook((void*)GetProcAddress(user32, "DefDlgProcW"), (void*)DefDlgProcW_hook, (void**)&DefDlgProcW_orig);
    Wh_SetFunctionHook((void*)GetProcAddress(user32, "DefDlgProcA"), (void*)DefDlgProcA_hook, (void**)&DefDlgProcA_orig);
    return TRUE;
}

void Wh_ModAfterInit() {
    EnumWindows(ApplyEnum, GetCurrentProcessId());
}

void Wh_ModSettingsChanged() {
    LoadSettings();
    EnumWindows(ApplyEnum, GetCurrentProcessId());
}

void Wh_ModUninit() {
    EnumWindows(ResetEnum, GetCurrentProcessId());
}
