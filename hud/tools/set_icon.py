"""Вписывает иконку в готовый exe через UpdateResource.

Компилятора ресурсов в поставке Rust для GNU нет, поэтому значок добавляем
после сборки: Windows умеет менять ресурсы уже собранного файла.

Запуск: python tools/set_icon.py <путь к exe> <путь к ico>
"""

import ctypes
import struct
import sys
from ctypes import wintypes

RT_ICON = 3
RT_GROUP_ICON = 14
LANG_NEUTRAL = 0

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
kernel32.BeginUpdateResourceW.restype = wintypes.HANDLE
kernel32.UpdateResourceW.argtypes = [
    wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPCWSTR,
    wintypes.WORD, wintypes.LPVOID, wintypes.DWORD,
]
kernel32.UpdateResourceW.restype = wintypes.BOOL
kernel32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
kernel32.EndUpdateResourceW.restype = wintypes.BOOL


def read_icon(path):
    """Разбирает .ico: заголовок, записи и сами изображения."""
    with open(path, "rb") as handle:
        data = handle.read()

    reserved, kind, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1:
        raise ValueError("это не файл .ico")

    images = []
    for index in range(count):
        offset = 6 + index * 16
        width, height, colors, _, planes, bits, size, position = struct.unpack(
            "<BBBBHHII", data[offset:offset + 16]
        )
        images.append({
            "width": width,
            "height": height,
            "colors": colors,
            "planes": planes,
            "bits": bits,
            "data": data[position:position + size],
        })
    return images


def build_group(images):
    """Каталог GRPICONDIR: он связывает значок с картинками внутри exe."""
    group = struct.pack("<HHH", 0, 1, len(images))
    for index, image in enumerate(images, start=1):
        group += struct.pack(
            "<BBBBHHIH",
            image["width"] & 0xFF,
            image["height"] & 0xFF,
            image["colors"],
            0,
            image["planes"],
            image["bits"],
            len(image["data"]),
            index,
        )
    return group


def apply_icon(exe_path, ico_path):
    images = read_icon(ico_path)
    handle = kernel32.BeginUpdateResourceW(exe_path, False)
    if not handle:
        raise OSError(f"не удалось открыть exe для правки: {ctypes.get_last_error()}")

    for index, image in enumerate(images, start=1):
        buffer = ctypes.create_string_buffer(image["data"])
        ok = kernel32.UpdateResourceW(
            handle, ctypes.cast(RT_ICON, wintypes.LPCWSTR), ctypes.cast(index, wintypes.LPCWSTR),
            LANG_NEUTRAL, buffer, len(image["data"]),
        )
        if not ok:
            raise OSError(f"не удалось записать изображение {index}")

    group = build_group(images)
    buffer = ctypes.create_string_buffer(group)
    ok = kernel32.UpdateResourceW(
        handle, ctypes.cast(RT_GROUP_ICON, wintypes.LPCWSTR), ctypes.cast(1, wintypes.LPCWSTR),
        LANG_NEUTRAL, buffer, len(group),
    )
    if not ok:
        raise OSError("не удалось записать каталог значка")

    if not kernel32.EndUpdateResourceW(handle, False):
        raise OSError(f"не удалось сохранить ресурсы: {ctypes.get_last_error()}")

    print(f"значок вписан в {exe_path}: {len(images)} размеров")


if __name__ == "__main__":
    apply_icon(sys.argv[1], sys.argv[2])
