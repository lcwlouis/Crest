using System.Globalization;
using System.Text.Json;

using CrestCore.Contracts;
using CrestCore.Generator;
using CrestCore.Native;

using Xunit;

namespace CrestCore.Tests;

/// The fixtures the TypeScript contracts are held to. The Linux interface
/// reads and writes the wire with a codec in another language, which no test
/// here can run, so the core's codec writes what it makes of every contract
/// value to a file, and `CrestLinux/WebUI/tests/contract_parity.mjs` checks
/// that the TypeScript codec reads each one and writes the same bytes back.
public sealed unsafe partial class ContractCodecTests {
    #region Static Variables

    /// The environment variable that names where the fixtures are written.
    /// Without it they go beside the tests, where the parity script looks.
    private const string FixturesVariable = "CREST_CONTRACT_FIXTURES";
    private const string FixturesFile = "contract-fixtures.json";

    #endregion

    #region Actions - Fixtures

    [Fact]
    public void TheCoreWritesAFixtureOfEveryContractValueForTheTypeScriptCodec() {
        var schema = ContractSchema.Load(Contracts);
        string path = Environment.GetEnvironmentVariable(FixturesVariable) is { Length: > 0 } named
            ? named
            : Path.Combine(AppContext.BaseDirectory, FixturesFile);
        var kinds = new List<string>();
        using (var stream = File.Create(path))
        using (var json = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true })) {
            json.WriteStartObject();
            json.WriteString("fingerprint", Convert.ToHexStringLower(ContractCodec.Fingerprint));
            WritePrimitives(json);
            json.WriteStartArray("values");
            foreach (var root in ContractRoot.All.Where(root => root.ReachesCore))
                foreach (var member in schema.Members(root))
                    foreach (bool optionals in new[] { true, false }) {
                        var value = Sample(member.Record.Type, null, optionals);
                        WriteFixture(json, root.Name, value, () => json.WriteString("kind", member.Name));
                        kinds.Add(member.Name);
                    }
            foreach (var record in schema.Records.Where(record => Writer(record.Name) is not null))
                foreach (bool optionals in new[] { true, false }) {
                    var value = Sample(record.Type, null, optionals);
                    WriteFixture(json, record.Name, value);
                    if (schema.HasSeed(record.Type)) WriteFixture(json, $"{record.Name}Seed", value);
                }
            foreach (var item in schema.Enums.Where(item => Writer(item.Name) is not null)) {
                var values = item.Members.Select(member => member.Value);
                foreach (int value in item.IsFlags ? values.Append(item.Members.Aggregate(0, (mask, member) => mask | member.Value)) : values)
                    WriteFixture(json, item.Name, Enum.ToObject(item.Type, value), () => {
                        if (item.IsFlags) json.WriteNumber("expected", value);
                        else json.WriteString("expected", item.Members[value].Key);
                    });
            }
            foreach (var set in schema.Sets.Where(set => !set.IsOpen && Writer(set.Name) is not null)) {
                var members = SetMembers(set.Type)!;
                foreach (var member in set.Members)
                    WriteFixture(json, set.Name, members[member.Tag], () => json.WriteString("expected", member.Name));
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }

        // An intent that nests records, lists and optionals, and a change that carries a whole session.
        Assert.Contains(nameof(OpenWorkspace), kinds);
        Assert.Contains(nameof(WorkspaceOpened), kinds);
        Assert.True(new FileInfo(path).Length > 0);
    }

    private static System.Reflection.MethodInfo? Writer(string codec) => typeof(ContractCodec).GetMethod($"Write{codec}");

    /// One value as the core's `codec` writes it, with what the TypeScript
    /// codec must make of it where the bytes alone do not say.
    private static void WriteFixture(Utf8JsonWriter json, string codec, object value, Action? expectation = null) {
        var bytes = AppClient.Encode(writer => Writer(codec)!.Invoke(null, [writer, value]));
        json.WriteStartObject();
        json.WriteString("codec", codec);
        expectation?.Invoke();
        json.WriteString("hex", Convert.ToHexStringLower(bytes));
        json.WriteEndObject();
    }

    /// One of each primitive the wire carries, in order, with the value the
    /// TypeScript reader must answer for it. A round trip alone would pass a
    /// reader and a writer that are wrong the same way, such as a GUID's
    /// bytes read in another order.
    private static void WritePrimitives(Utf8JsonWriter json) {
        var guid = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
        var date = new DateTimeOffset(2026, 9, 23, 12, 30, 15, 250, TimeSpan.Zero);
        const string text = "Téléchargement ﻿‮.pdf 🦊";
        byte[] blob = [0, 0x7f, 0x80, 0xff];
        var bytes = AppClient.Encode(writer => {
            writer.WriteTag(300);
            writer.WriteBool(true);
            writer.WriteInt32(int.MinValue);
            writer.WriteInt64(long.MinValue + 1);
            writer.WriteUInt64(ulong.MaxValue);
            writer.WriteDouble(-0.1);
            writer.WriteString(text);
            writer.WriteBytes(blob);
            writer.WriteGuid(guid);
            writer.WriteDate(date);
            writer.WriteDuration(TimeSpan.FromSeconds(90.5));
            writer.WritePresence(false);
        });
        json.WriteStartObject("primitives");
        json.WriteString("hex", Convert.ToHexStringLower(bytes));
        json.WriteStartArray("expected");
        void Expect(string method, Action<string> write) {
            json.WriteStartObject();
            json.WriteString("method", method);
            write("value");
            json.WriteEndObject();
        }
        Expect("tag", name => json.WriteNumber(name, 300));
        Expect("bool", name => json.WriteBoolean(name, true));
        Expect("int32", name => json.WriteNumber(name, int.MinValue));
        Expect("int64", name => json.WriteString(name, (long.MinValue + 1).ToString(CultureInfo.InvariantCulture)));
        Expect("uint64", name => json.WriteString(name, ulong.MaxValue.ToString(CultureInfo.InvariantCulture)));
        Expect("double", name => json.WriteNumber(name, -0.1));
        Expect("string", name => json.WriteString(name, text));
        Expect("byteString", name => json.WriteString(name, Convert.ToHexStringLower(blob)));
        Expect("guid", name => json.WriteString(name, guid.ToString("D")));
        Expect("date", name => json.WriteString(name, date.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)));
        Expect("duration", name => json.WriteNumber(name, 90.5));
        Expect("presence", name => json.WriteBoolean(name, false));
        json.WriteEndArray();
        json.WriteEndObject();
    }

    #endregion
}
