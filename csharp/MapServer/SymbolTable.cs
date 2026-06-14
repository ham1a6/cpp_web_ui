using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace MapServer;

/// <summary>Symbol entry matching the JSON shape sent to the browser.</summary>
public record SymbolEntry(double Lat, double Lon, string Label, string Type);

/// <summary>
/// Thread-safe symbol storage with integrated SSE broadcast.
/// </summary>
public sealed class SymbolTable
{
    private readonly ConcurrentDictionary<string, SymbolEntry> _symbols = new();

    // Labels that came from SHM (so we can remove them when they disappear from SHM)
    private readonly HashSet<string> _shmLabels = new();
    private readonly object _shmLabelLock = new();

    // SSE subscribers — one Channel<string> per connected browser
    private readonly List<ChannelWriter<string>> _writers = new();
    private readonly object _writerLock = new();

    // -------------------------------------------------------------------------

    public string Snapshot()
    {
        var arr = _symbols.Values
            .Select(s => new { lat = s.Lat, lon = s.Lon, label = s.Label, type = s.Type });
        return JsonSerializer.Serialize(arr);
    }

    public ChannelReader<string> Subscribe()
    {
        var ch = Channel.CreateUnbounded<string>(
            new UnboundedChannelOptions { SingleReader = true });
        lock (_writerLock) _writers.Add(ch.Writer);
        return ch.Reader;
    }

    public void Unsubscribe(ChannelReader<string> reader)
    {
        // Find the writer whose reader matches (same channel)
        lock (_writerLock)
        {
            // We don't have a direct handle back, so mark completed and remove closed ones
            _writers.RemoveAll(w => w.TryComplete());
        }
    }

    private void Broadcast(string snapshot)
    {
        lock (_writerLock)
        {
            _writers.RemoveAll(w =>
            {
                if (!w.TryWrite(snapshot))
                {
                    w.TryComplete();
                    return true;
                }
                return false;
            });
        }
    }

    // -------------------------------------------------------------------------

    public void Set(string label, double lat, double lon, string type)
    {
        _symbols[label] = new SymbolEntry(lat, lon, label, type);
        Broadcast(Snapshot());
    }

    public void Remove(string label)
    {
        _symbols.TryRemove(label, out _);
        lock (_shmLabelLock) _shmLabels.Remove(label);
        Broadcast(Snapshot());
    }

    public void Clear()
    {
        _symbols.Clear();
        lock (_shmLabelLock) _shmLabels.Clear();
        Broadcast(Snapshot());
    }

    /// <summary>
    /// Called by ShmPoller when a new SHM snapshot is available.
    /// Adds/updates SHM-owned symbols and removes ones that disappeared.
    /// </summary>
    public void UpdateFromShm(IReadOnlyList<(string Label, double Lat, double Lon, string Type)> entries)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (label, lat, lon, type) in entries)
        {
            if (string.IsNullOrEmpty(label)) continue;
            seen.Add(label);
            _symbols[label] = new SymbolEntry(lat, lon, label, type);
        }

        lock (_shmLabelLock)
        {
            foreach (var old in _shmLabels.Except(seen).ToList())
                _symbols.TryRemove(old, out _);
            _shmLabels.Clear();
            foreach (var s in seen) _shmLabels.Add(s);
        }

        Broadcast(Snapshot());
    }
}
