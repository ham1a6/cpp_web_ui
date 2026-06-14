using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Text;

namespace MapServer;

/// <summary>
/// Polls a shared memory segment every 100 ms and updates SymbolTable when
/// the version field changes.
///
/// Platform backends:
///   Linux   — POSIX shm_open("/map_positions") via P/Invoke (librt / libc)
///   Windows — MemoryMappedFile.OpenExisting("map_positions") named kernel object
///
/// Binary layout (shared_types.h):
///   offset  0 : uint32  version
///   offset  4 : uint32  count
///   offset  8 : Symbol[64], stride 72 bytes each:
///                 +0  double lat
///                 +8  double lon
///                 +16 char[32] label
///                 +48 char[16] type
///                 +64 int     active
///                 +68 (4 bytes padding — double alignment)
/// Total: 4616 bytes
/// </summary>
public sealed class ShmPoller : BackgroundService
{
    private const int ShmTotalBytes = 4616;
    private const int SymbolStride  = 72;
    private const int MaxSymbols    = 64;

    private readonly string _shmName; // e.g. "/map_positions"
    private readonly SymbolTable _symbols;
    private readonly ILogger<ShmPoller> _log;
    private uint _lastVersion;

    // ---- Linux P/Invoke ----
    private const int O_RDONLY  = 0;
    private const int PROT_READ = 1;
    private const int MAP_SHARED = 1;
    private static readonly nint MAP_FAILED = -1;

    [DllImport("librt", EntryPoint = "shm_open", SetLastError = true)]
    private static extern int PosixShmOpen(string name, int oflag, uint mode);

    // Fallback: some distros put shm_open in libc rather than librt
    [DllImport("libc", EntryPoint = "shm_open", SetLastError = true)]
    private static extern int LibcShmOpen(string name, int oflag, uint mode);

    [DllImport("libc", EntryPoint = "mmap", SetLastError = true)]
    private static extern nint Mmap(nint addr, nuint len, int prot, int flags,
                                    int fd, long offset);

    [DllImport("libc", EntryPoint = "munmap")]
    private static extern int Munmap(nint addr, nuint len);

    [DllImport("libc", EntryPoint = "close")]
    private static extern int Closefd(int fd);

    // ---- Windows backend ----
    // Wrapped in a nested class to avoid loading platform-check attributes at
    // class-load time on Linux (the MemoryMappedFile API is Windows-only for
    // the named case, but the type itself loads fine).
    private MemoryMappedFile?         _winMmf;
    private MemoryMappedViewAccessor? _winView;

    // ---- Linux backend ----
    private nint _linuxPtr = MAP_FAILED;

    public ShmPoller(string shmName, SymbolTable symbols, ILogger<ShmPoller> log)
    {
        _shmName = shmName; // keep leading '/' for POSIX
        _symbols  = symbols;
        _log      = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _log.LogInformation("ShmPoller: watching \"{Name}\"", _shmName);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                Poll();
                await Task.Delay(100, ct);
            }
        }
        catch (OperationCanceledException) { }
        finally { CloseShm(); }
    }

    private bool OpenShm()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            return OpenShmLinux();
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return OpenShmWindows();
        return false;
    }

    private bool OpenShmLinux()
    {
        if (_linuxPtr != MAP_FAILED) return true;

        // Try librt first, fall back to libc
        int fd = -1;
        try       { fd = PosixShmOpen(_shmName, O_RDONLY, 0); }
        catch     { fd = -1; }
        if (fd < 0)
        {
            try   { fd = LibcShmOpen(_shmName, O_RDONLY, 0); }
            catch { fd = -1; }
        }
        if (fd < 0) return false;

        nint ptr = Mmap(0, ShmTotalBytes, PROT_READ, MAP_SHARED, fd, 0);
        Closefd(fd); // file descriptor no longer needed after mmap
        if (ptr == MAP_FAILED) return false;

        _linuxPtr = ptr;
        _log.LogInformation("ShmPoller: opened POSIX SHM \"{Name}\"", _shmName);
        return true;
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private bool OpenShmWindows()
    {
        if (_winView is not null) return true;
        string name = _shmName.TrimStart('/');
        try
        {
            _winMmf  = MemoryMappedFile.OpenExisting(name, MemoryMappedFileRights.Read);
            _winView = _winMmf.CreateViewAccessor(
                0, ShmTotalBytes, MemoryMappedFileAccess.Read);
            _log.LogInformation("ShmPoller: opened named MMF \"{Name}\"", name);
            return true;
        }
        catch
        {
            _winMmf?.Dispose(); _winMmf = null;
            return false;
        }
    }

    private void CloseShm()
    {
        if (_linuxPtr != MAP_FAILED)
        { Munmap(_linuxPtr, ShmTotalBytes); _linuxPtr = MAP_FAILED; }

        _winView?.Dispose(); _winView = null;
        _winMmf?.Dispose();  _winMmf  = null;
    }

    private void Poll()
    {
        if (!OpenShm()) return;
        try
        {
            byte[] bytes = ReadShmBytes();
            uint version = BitConverter.ToUInt32(bytes, 0);
            if (version == _lastVersion) return;
            _lastVersion = version;

            uint rawCount = BitConverter.ToUInt32(bytes, 4);
            int  count    = (int)Math.Min(rawCount, (uint)MaxSymbols);

            var entries = new List<(string, double, double, string)>(count);
            for (int i = 0; i < count; i++)
            {
                int off    = 8 + i * SymbolStride;
                int active = BitConverter.ToInt32(bytes, off + 64);
                if (active == 0) continue;

                double lat   = BitConverter.ToDouble(bytes, off + 0);
                double lon   = BitConverter.ToDouble(bytes, off + 8);
                string label = ReadNullTerminated(bytes, off + 16, 32);
                string type  = ReadNullTerminated(bytes, off + 48, 16);

                if (!string.IsNullOrEmpty(label))
                    entries.Add((label, lat, lon, type));
            }
            _symbols.UpdateFromShm(entries);
        }
        catch (Exception ex)
        {
            _log.LogWarning("ShmPoller: read error — {Msg}", ex.Message);
            CloseShm();
        }
    }

    private unsafe byte[] ReadShmBytes()
    {
        byte[] buf = new byte[ShmTotalBytes];

        if (_linuxPtr != MAP_FAILED)
        {
            Marshal.Copy(_linuxPtr, buf, 0, ShmTotalBytes);
            return buf;
        }

        // Windows path
        _winView!.ReadArray(0, buf, 0, ShmTotalBytes);
        return buf;
    }

    private static string ReadNullTerminated(byte[] buf, int offset, int maxLen)
    {
        int len = 0;
        while (len < maxLen && buf[offset + len] != 0) len++;
        return Encoding.UTF8.GetString(buf, offset, len);
    }
}
