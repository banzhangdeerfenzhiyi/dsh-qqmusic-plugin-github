// Scan the running QQ Music client's memory for its web-login cookie
// (qqmusic_key / qm_keyst). When the client is already logged in there is no
// need to make the user scan anything - we can lift the session directly.
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public class QqMemScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MEMORY_BASIC_INFORMATION info, UIntPtr length);

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public int AllocationProtect;
        public IntPtr RegionSize;
        public int State;
        public int Protect;
        public int Type;
    }

    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_VM_READ = 0x0010;
    const int MEM_COMMIT = 0x1000;

    static bool Readable(int protect)
    {
        if ((protect & 0x100) != 0) return false; // PAGE_GUARD
        int p = protect & 0xff;
        return p == 0x02 || p == 0x04 || p == 0x08 || p == 0x20 || p == 0x40 || p == 0x80;
    }

    // Returns "pattern|context" lines: the interesting strings found in memory.
    public static List<string> Scan(int pid, string[] patterns, long maxBytes)
    {
        var hits = new List<string>();
        var seen = new HashSet<string>();
        IntPtr process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (process == IntPtr.Zero) throw new InvalidOperationException("OpenProcess failed: " + Marshal.GetLastWin32Error());
        long scanned = 0;
        IntPtr address = IntPtr.Zero;
        try
        {
            while (scanned < maxBytes)
            {
                MEMORY_BASIC_INFORMATION info;
                UIntPtr q = VirtualQueryEx(process, address, out info, (UIntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION)));
                if (q == UIntPtr.Zero) break;
                long regionSize = info.RegionSize.ToInt64();
                if (regionSize <= 0) break;
                if (info.State == MEM_COMMIT && Readable(info.Protect) && regionSize <= 64L * 1024 * 1024)
                {
                    int size = (int)Math.Min(regionSize, 4L * 1024 * 1024);
                    long offset = 0;
                    while (offset < regionSize && scanned < maxBytes)
                    {
                        int chunk = (int)Math.Min(size, regionSize - offset);
                        byte[] buffer = new byte[chunk];
                        IntPtr read;
                        if (ReadProcessMemory(process, new IntPtr(info.BaseAddress.ToInt64() + offset), buffer, chunk, out read) && read.ToInt64() > 0)
                        {
                            int got = (int)read.ToInt64();
                            scanned += got;
                            string text = Encoding.GetEncoding(28591).GetString(buffer, 0, got);
                            foreach (string pattern in patterns)
                            {
                                int index = text.IndexOf(pattern, StringComparison.Ordinal);
                                while (index >= 0)
                                {
                                    int start = Math.Max(0, index - 160);
                                    int end = Math.Min(text.Length, index + 320);
                                    string snippet = text.Substring(start, end - start);
                                    if (seen.Add(snippet)) hits.Add(pattern + "|" + snippet);
                                    if (hits.Count > 400) return hits;
                                    index = text.IndexOf(pattern, index + 1, StringComparison.Ordinal);
                                }
                            }
                        }
                        offset += chunk;
                    }
                    if (regionSize > 64L * 1024 * 1024) scanned += regionSize; // count skipped giant regions
                }
                address = new IntPtr(info.BaseAddress.ToInt64() + regionSize);
                if (address.ToInt64() <= 0) break;
            }
        }
        finally
        {
            CloseHandle(process);
        }
        return hits;
    }
}
