/**
 * Read the icon resource out of a compiled Windows executable and write it
 * as a BMP.
 *
 * This exists because the icon stamping step once "succeeded" — three
 * Win32 UpdateResource calls returned true, the build exited 0 — and the
 * exe still shipped bun's default mark. The step had no way to see what it
 * wrote, so a silently-wrong icon looked exactly like a working one. This
 * is the read side: `LoadImage` on an AS_DATAFILE handle is the same read
 * path Explorer, the taskbar and the file-properties sheet use, so what it
 * returns is what a user sees.
 *
 * Built on demand by the caller (`clang-cl` from the LLVM on the machine,
 * or any MSVC-compatible toolchain) rather than committed as a binary:
 * one small C file, no dependencies, and a build that cannot compile it
 * should say so rather than skip the check.
 *
 * usage: icon-verify <exe> <out.bmp>
 * exit 0 = the icon was read and written; 3/4 = the resource is missing.
 */
#include <windows.h>
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: icon-verify <exe> <out.bmp>\n");
    return 2;
  }
  HMODULE mod = LoadLibraryExA(argv[1], NULL, LOAD_LIBRARY_AS_DATAFILE);
  if (!mod) {
    fprintf(stderr, "LoadLibraryEx failed: %lu\n", GetLastError());
    return 3;
  }
  // RT_GROUP_ICON id 1 — the id the stamp step writes. LoadImage resolves
  // the group to the right RT_ICON for the requested size, so a group that
  // declares only a 16px image answers a 32px request with the default
  // mark — which is exactly the failure this reader exists to catch.
  HICON icon = (HICON)LoadImageA(mod, "#1", IMAGE_ICON, 32, 32,
                                 LR_DEFAULTSIZE | LR_SHARED);
  if (!icon) {
    fprintf(stderr, "LoadImage failed: %lu\n", GetLastError());
    FreeLibrary(mod);
    return 4;
  }
  ICONINFO info;
  if (!GetIconInfo(icon, &info)) {
    fprintf(stderr, "GetIconInfo failed: %lu\n", GetLastError());
    DestroyIcon(icon);
    FreeLibrary(mod);
    return 5;
  }
  // The colour bitmap is a 32bpp DIB; icons are top-down, hence the
  // negative height.
  BITMAP bm;
  GetObjectA(info.hbmColor, sizeof(bm), &bm);
  HDC dc = GetDC(NULL);
  HDC mem = CreateCompatibleDC(dc);
  BITMAPINFO bi;
  ZeroMemory(&bi, sizeof(bi));
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = bm.bmWidth;
  bi.bmiHeader.biHeight = -bm.bmHeight;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void *pixels = NULL;
  HBITMAP dib = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &pixels, NULL, 0);
  SelectObject(mem, dib);
  DrawIconEx(mem, 0, 0, icon, bm.bmWidth, bm.bmHeight, 0, NULL, DI_NORMAL);
  BITMAPFILEHEADER fh;
  fh.bfType = 0x4D42;
  fh.bfReserved1 = 0;
  fh.bfReserved2 = 0;
  fh.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
  fh.bfSize = fh.bfOffBits + bm.bmWidth * bm.bmHeight * 4;
  FILE *out = fopen(argv[2], "wb");
  if (!out) {
    fprintf(stderr, "cannot open %s\n", argv[2]);
    return 6;
  }
  fwrite(&fh, sizeof(fh), 1, out);
  fwrite(&bi.bmiHeader, sizeof(BITMAPINFOHEADER), 1, out);
  fwrite(pixels, bm.bmWidth * bm.bmHeight * 4, 1, out);
  fclose(out);
  printf("wrote %s (%dx%d)\n", argv[2], bm.bmWidth, bm.bmHeight);
  DeleteObject(dib);
  DeleteDC(mem);
  ReleaseDC(NULL, dc);
  DestroyIcon(icon);
  FreeLibrary(mod);
  return 0;
}
