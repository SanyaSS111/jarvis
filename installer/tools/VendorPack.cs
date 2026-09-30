// Packs a ready folder from this PC into a vendor-*.zip of the offline bundle (used by build.ps1).
// Every file is searched for the needles (the build PC's real key values, its user-profile path)
// before it goes in; any hit is returned and build.ps1 stops. Junctions/symlinks are skipped
// (the installer recreates the ones it needs). Entries use '/' separators.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

public static class VendorPack
{
    static readonly byte[] Lower = MakeLower();
    static byte[] MakeLower()
    {
        var t = new byte[256];
        for (int i = 0; i < 256; i++) t[i] = (byte)(i >= 'A' && i <= 'Z' ? i + 32 : i);
        return t;
    }

    // needles[i] is compared case-insensitively (ASCII letters) when ignoreCase[i].
    static int Find(byte[] h, int len, byte[] n, bool ignoreCase)
    {
        int last = len - n.Length;
        byte f = n[0], fl = Lower[n[0]];
        for (int i = 0; i <= last; i++)
        {
            byte b = h[i];
            if (b != f && !(ignoreCase && Lower[b] == fl)) continue;
            int j = 1;
            if (ignoreCase) while (j < n.Length && Lower[h[i + j]] == Lower[n[j]]) j++;
            else while (j < n.Length && h[i + j] == n[j]) j++;
            if (j == n.Length) return i;
        }
        return -1;
    }

    static IEnumerable<string> Files(string dir)
    {
        var stack = new Stack<string>();
        stack.Push(dir);
        while (stack.Count > 0)
        {
            string d = stack.Pop();
            foreach (var f in Directory.GetFiles(d))
                if ((File.GetAttributes(f) & FileAttributes.ReparsePoint) == 0) yield return f;
            foreach (var s in Directory.GetDirectories(d))
                if ((File.GetAttributes(s) & FileAttributes.ReparsePoint) == 0) stack.Push(s);
        }
    }

    public static string[] List(string srcDir, string exclude)
    {
        var rx = string.IsNullOrEmpty(exclude) ? null : new Regex(exclude, RegexOptions.IgnoreCase);
        string root = Path.GetFullPath(srcDir).TrimEnd('\\') + "\\";
        var list = new List<string>();
        foreach (var f in Files(root))
        {
            string rel = f.Substring(root.Length).Replace('\\', '/');
            if (rx == null || !rx.IsMatch(rel)) list.Add(rel);
        }
        list.Sort(StringComparer.Ordinal);
        return list.ToArray();
    }

    // Count, total size and newest write time of the files that would be packed: the cache key.
    public static string Fingerprint(string srcDir, string exclude)
    {
        long size = 0, newest = 0;
        var files = List(srcDir, exclude);
        foreach (var rel in files)
        {
            var fi = new FileInfo(Path.Combine(srcDir, rel.Replace('/', '\\')));
            size += fi.Length;
            newest = Math.Max(newest, fi.LastWriteTimeUtc.Ticks);
        }
        return files.Length + ":" + size + ":" + newest;
    }

    public static string[] Pack(string srcDir, string zipPath, string exclude, byte[][] needles, bool[] ignoreCase, string[] labels)
    {
        var hits = new List<string>();
        var files = List(srcDir, exclude);
        byte[] buf = new byte[1 << 20];
        using (var zs = File.Create(zipPath))
        using (var za = new ZipArchive(zs, ZipArchiveMode.Create))
        {
            foreach (var rel in files)
            {
                string full = Path.Combine(srcDir, rel.Replace('/', '\\'));
                long length = new FileInfo(full).Length;
                if (length > int.MaxValue) throw new Exception("file too large: " + rel);
                if (buf.Length < length) buf = new byte[length];
                int len = 0;
                using (var fs = File.OpenRead(full))
                {
                    int n;
                    while (len < length && (n = fs.Read(buf, len, (int)length - len)) > 0) len += n;
                }
                for (int i = 0; i < needles.Length; i++)
                    if (len >= needles[i].Length && Find(buf, len, needles[i], ignoreCase[i]) >= 0) hits.Add(rel + ": " + labels[i]);
                var e = za.CreateEntry(rel, CompressionLevel.Optimal);
                e.LastWriteTime = File.GetLastWriteTime(full);
                using (var es = e.Open()) es.Write(buf, 0, len);
            }
        }
        return hits.ToArray();
    }
}
