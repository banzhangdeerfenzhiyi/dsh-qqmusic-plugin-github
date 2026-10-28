// Bounded, local diagnostic for outgoing message bodies.
//
// Purpose: learn the real layout of the 4.1.10.27 outbound *voice* message
// object by observing a voice the bot account sends itself. Metadata only:
// field offsets, string lengths, short previews, a bounded hex slice of the
// object, module/heap pointer slots, small integers and the first bytes of any
// sub-object the body points at. Nothing leaves the machine; the trace expires
// after a few minutes.
//
// MSVC refuses SEH (`__try`) in a function that also needs C++ object
// unwinding (C2712), so every guarded read lives in a POD-only helper and JSON
// is built outside them. Preview strings are forced to valid text and the final
// dump uses the replace error handler.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <mutex>
#include <string>
#include <vector>
#include "MinHook.h"
#include "json.hpp"
#include "voice_trace.h"

namespace WeChatAgentVoiceTrace {
namespace {
using DispatchCall = uintptr_t(*)(uintptr_t, uintptr_t, uintptr_t, bool);
using SendCall = uintptr_t(*)(uintptr_t, uintptr_t);
DispatchCall original = nullptr;
SendCall originalSend = nullptr;
std::mutex traceMutex;
bool armed = false;
ULONGLONG expires = 0;
std::vector<nlohmann::json> rows;

constexpr size_t HEX_MAX = 0x800;
constexpr size_t SCAN_MAX = 0x900;
constexpr size_t MAX_PTRS = 80;
constexpr size_t MAX_INTS = 160;
constexpr size_t MAX_NESTED = 8;
constexpr size_t NESTED_BYTES = 0x60;

struct RawScan {
    char hex[HEX_MAX * 2 + 1];
    size_t hexBytes;
    unsigned pointerCount;
    unsigned pointerOffsets[MAX_PTRS];
    unsigned long long pointerRvas[MAX_PTRS];
    unsigned heapPointerCount;
    unsigned heapPointerOffsets[MAX_PTRS];
    unsigned intCount;
    unsigned intOffsets[MAX_INTS];
    unsigned long long intValues[MAX_INTS];
};

bool CopyHex(uintptr_t region, size_t hexLen, RawScan* out) {
    __try {
        if (hexLen > HEX_MAX) hexLen = HEX_MAX;
        static const char digits[] = "0123456789abcdef";
        const unsigned char* bytes = reinterpret_cast<const unsigned char*>(region);
        for (size_t i = 0; i < hexLen; ++i) {
            out->hex[i * 2] = digits[bytes[i] >> 4];
            out->hex[i * 2 + 1] = digits[bytes[i] & 15];
        }
        out->hex[hexLen * 2] = '\0';
        out->hexBytes = hexLen;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

bool ScanPointerSlots(uintptr_t region, uintptr_t base, size_t scanLen, RawScan* out) {
    __try {
        if (scanLen > SCAN_MAX) scanLen = SCAN_MAX;
        for (size_t off = 0; off + 8 <= scanLen; off += 8) {
            uint64_t value = *reinterpret_cast<uint64_t*>(region + off);
            if (value >= base && value - base < 0x10000000ULL) {
                if (out->pointerCount < MAX_PTRS) {
                    out->pointerOffsets[out->pointerCount] = static_cast<unsigned>(off);
                    out->pointerRvas[out->pointerCount] = value - base;
                    out->pointerCount++;
                }
            } else if (value >= 0x10000ULL && value < 0x00007FFFFFFFFFFFULL) {
                if (out->heapPointerCount < MAX_PTRS) {
                    out->heapPointerOffsets[out->heapPointerCount++] = static_cast<unsigned>(off);
                }
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

bool ScanIntSlots(uintptr_t region, size_t scanLen, RawScan* out) {
    __try {
        if (scanLen > SCAN_MAX) scanLen = SCAN_MAX;
        for (size_t off = 0; off + 4 <= scanLen; off += 4) {
            uint32_t value = *reinterpret_cast<uint32_t*>(region + off);
            if (value > 0 && value < 0x100000) {
                if (out->intCount < MAX_INTS) {
                    out->intOffsets[out->intCount] = static_cast<unsigned>(off);
                    out->intValues[out->intCount] = value;
                    out->intCount++;
                }
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

void CaptureRange(uintptr_t region, uintptr_t base, size_t hexLen, size_t scanLen, RawScan* out) {
    out->hex[0] = '\0';
    out->hexBytes = 0;
    out->pointerCount = 0;
    out->heapPointerCount = 0;
    out->intCount = 0;
    CopyHex(region, hexLen, out);
    ScanPointerSlots(region, base, scanLen, out);
    ScanIntSlots(region, scanLen, out);
}

struct NestedObject {
    unsigned offset;
    unsigned long long vtableRva;
    char hex[NESTED_BYTES * 2 + 1];
};

struct NestedList {
    unsigned count;
    NestedObject items[MAX_NESTED];
};

bool ReadNestedOne(uintptr_t region, size_t off, uintptr_t base, NestedObject* item) {
    __try {
        uint64_t value = *reinterpret_cast<uint64_t*>(region + off);
        if (value < 0x10000ULL || value >= 0x00007FFFFFFFFFFFULL) return false;
        auto target = static_cast<uintptr_t>(value);
        item->offset = static_cast<unsigned>(off);
        item->vtableRva = *reinterpret_cast<uintptr_t*>(target) - base;
        static const char digits[] = "0123456789abcdef";
        const unsigned char* bytes = reinterpret_cast<const unsigned char*>(target);
        for (size_t i = 0; i < NESTED_BYTES; ++i) {
            item->hex[i * 2] = digits[bytes[i] >> 4];
            item->hex[i * 2 + 1] = digits[bytes[i] & 15];
        }
        item->hex[NESTED_BYTES * 2] = '\0';
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

void CaptureNested(uintptr_t region, uintptr_t base, size_t scanLen, NestedList* out) {
    out->count = 0;
    if (scanLen > SCAN_MAX) scanLen = SCAN_MAX;
    for (size_t off = 0x600; off + 8 <= scanLen && out->count < MAX_NESTED; off += 8) {
        NestedObject item = {};
        if (ReadNestedOne(region, off, base, &item)) out->items[out->count++] = item;
    }
}

bool PrintableAscii(const char* data, size_t length) {
    if (length == 0 || length > 240) return false;
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = static_cast<unsigned char>(data[i]);
        if (c < 0x20 || c >= 0x7f) {
            if (c == '\t' || c == '\r' || c == '\n') continue;
            return false;
        }
    }
    return true;
}

bool PrintableWide(const wchar_t* data, size_t length) {
    if (length == 0 || length > 240) return false;
    for (size_t i = 0; i < length; ++i) {
        wchar_t c = data[i];
        if (c == 0) return false;
        if (c < 0x20 && c != L'\t' && c != L'\r' && c != L'\n') return false;
    }
    return true;
}

bool ProbeNarrow(uintptr_t region, size_t off, size_t scanLen, size_t* sizeOut,
                 char* preview, size_t previewCap) {
    __try {
        if (off + 0x20 > scanLen) return false;
        uint64_t size = *reinterpret_cast<uint64_t*>(region + off + 0x10);
        uint64_t capacity = *reinterpret_cast<uint64_t*>(region + off + 0x18);
        if (size == 0 || size > 240) return false;
        if (!(capacity == 15 || (capacity >= size && capacity <= 4096))) return false;
        const char* text = capacity < 16
            ? reinterpret_cast<const char*>(region + off)
            : *reinterpret_cast<const char**>(region + off);
        if (!text) return false;
        if (!PrintableAscii(text, static_cast<size_t>(size))) return false;
        size_t copy = static_cast<size_t>(size) < previewCap - 1 ? static_cast<size_t>(size) : previewCap - 1;
        memcpy(preview, text, copy);
        preview[copy] = '\0';
        *sizeOut = static_cast<size_t>(size);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

bool ProbeWide(uintptr_t region, size_t off, size_t scanLen, size_t* sizeOut,
               char* preview, size_t previewCap) {
    __try {
        if (off + 0x20 > scanLen) return false;
        uint64_t size = *reinterpret_cast<uint64_t*>(region + off + 0x10);
        uint64_t capacity = *reinterpret_cast<uint64_t*>(region + off + 0x18);
        if (size == 0 || size > 240) return false;
        if (!(capacity == 7 || (capacity >= size && capacity <= 4096))) return false;
        const wchar_t* text = capacity < 8
            ? reinterpret_cast<const wchar_t*>(region + off)
            : *reinterpret_cast<const wchar_t**>(region + off);
        if (!text) return false;
        if (!PrintableWide(text, static_cast<size_t>(size))) return false;
        int bytes = WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(size), nullptr, 0, nullptr, nullptr);
        if (bytes <= 0) return false;
        char buffer[256] = {};
        int copy = bytes < static_cast<int>(sizeof(buffer) - 1) ? bytes : static_cast<int>(sizeof(buffer) - 1);
        WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(size), buffer, copy, nullptr, nullptr);
        size_t keep = static_cast<size_t>(copy) < previewCap - 1 ? static_cast<size_t>(copy) : previewCap - 1;
        memcpy(preview, buffer, keep);
        preview[keep] = '\0';
        *sizeOut = static_cast<size_t>(size);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

uintptr_t SingleBody(uintptr_t vector) {
    __try {
        auto begin = *reinterpret_cast<uintptr_t*>(vector);
        auto end = *reinterpret_cast<uintptr_t*>(vector + 8);
        return end - begin == 16 ? *reinterpret_cast<uintptr_t*>(begin) : 0;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}

struct SendPointers {
    uintptr_t inner;
    uintptr_t body;
    uintptr_t owner;
};

bool ReadSendPointers(uintptr_t wrapper, SendPointers* out) {
    __try {
        out->inner = *reinterpret_cast<uintptr_t*>(wrapper + 8);
        out->body = *reinterpret_cast<uintptr_t*>(out->inner);
        out->owner = *reinterpret_cast<uintptr_t*>(out->inner + 8);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return out->owner > 0x10000;
}

bool ReadVtableSlot(uintptr_t region, uintptr_t base, uintptr_t* rva) {
    __try {
        uintptr_t value = *reinterpret_cast<uintptr_t*>(region);
        if (value < base || value - base >= 0x10000000ULL) return false;
        *rva = value - base;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

bool ReadTypeSlots(uintptr_t region, uintptr_t offset, unsigned* type, unsigned* subtype) {
    __try {
        *type = *reinterpret_cast<unsigned*>(region + offset + 0xD8);
        *subtype = *reinterpret_cast<unsigned*>(region + offset + 0xDC);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

nlohmann::json ScanStrings(uintptr_t region, size_t scanLen) {
    nlohmann::json fields = nlohmann::json::array();
    char preview[256];
    for (size_t off = 0; off + 0x20 <= scanLen; off += 8) {
        size_t length = 0;
        if (ProbeNarrow(region, off, scanLen, &length, preview, sizeof(preview))) {
            fields.push_back({{"off", off}, {"kind", "s"}, {"len", length}, {"preview", preview}});
        }
        preview[0] = '\0';
        if (ProbeWide(region, off, scanLen, &length, preview, sizeof(preview))) {
            fields.push_back({{"off", off}, {"kind", "w"}, {"len", length}, {"preview", preview}});
        }
    }
    return fields;
}

nlohmann::json RawJson(const RawScan& scan) {
    nlohmann::json raw;
    raw["hex"] = scan.hex;
    nlohmann::json pointers = nlohmann::json::array();
    for (unsigned i = 0; i < scan.pointerCount; ++i) {
        pointers.push_back({{"off", scan.pointerOffsets[i]}, {"rva", scan.pointerRvas[i]}});
    }
    raw["modulePointers"] = std::move(pointers);
    nlohmann::json heap = nlohmann::json::array();
    for (unsigned i = 0; i < scan.heapPointerCount; ++i) heap.push_back(scan.heapPointerOffsets[i]);
    raw["heapPointerOffsets"] = std::move(heap);
    nlohmann::json ints = nlohmann::json::array();
    for (unsigned i = 0; i < scan.intCount; ++i) {
        ints.push_back({{"off", scan.intOffsets[i]}, {"value", scan.intValues[i]}});
    }
    raw["smallInts"] = std::move(ints);
    return raw;
}

nlohmann::json NestedJson(const NestedList& nested) {
    nlohmann::json items = nlohmann::json::array();
    for (unsigned i = 0; i < nested.count; ++i) {
        items.push_back({{"off", nested.items[i].offset},
                         {"vtableRva", nested.items[i].vtableRva},
                         {"hex", nested.items[i].hex}});
    }
    return items;
}

nlohmann::json BuildRow(const char* source, uintptr_t region, uintptr_t base, size_t bodyOffset) {
    nlohmann::json row;
    row["src"] = source;
    uintptr_t vtableRva = 0;
    if (ReadVtableSlot(region, base, &vtableRva)) row["vtableRva"] = vtableRva;
    unsigned type = 0, subtype = 0;
    if (ReadTypeSlots(region, bodyOffset, &type, &subtype)) {
        row["type"] = type;
        row["subtype"] = subtype;
    }
    row["fields"] = ScanStrings(region, SCAN_MAX);
    RawScan scan = {};
    CaptureRange(region, base, HEX_MAX, SCAN_MAX, &scan);
    if (scan.hexBytes == 0) {
        // Region may be shorter than a full message object; keep a shorter slice.
        CaptureRange(region, base, 0x400, 0x400, &scan);
    }
    if (scan.hexBytes == 0) CaptureRange(region, base, 0x200, 0x200, &scan);
    row["raw"] = RawJson(scan);
    NestedList nested = {};
    CaptureNested(region, base, SCAN_MAX, &nested);
    if (nested.count > 0) row["nested"] = NestedJson(nested);
    row["tick"] = GetTickCount64();
    return row;
}

void PushRow(nlohmann::json row) {
    std::lock_guard<std::mutex> lock(traceMutex);
    if (!armed || GetTickCount64() > expires) return;
    if (rows.size() >= 24) rows.erase(rows.begin());
    rows.push_back(std::move(row));
}

void Observe(uintptr_t vector) {
    {
        std::lock_guard<std::mutex> lock(traceMutex);
        if (!armed || GetTickCount64() > expires) return;
    }
    auto body = SingleBody(vector);
    if (!body) return;
    auto base = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    if (!base) return;
    PushRow(BuildRow("dispatch", body, base, 0));
}

void ObserveSend(uintptr_t wrapper, uintptr_t parameters) {
    {
        std::lock_guard<std::mutex> lock(traceMutex);
        if (!armed || GetTickCount64() > expires) return;
    }
    auto base = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    if (!base) return;
    SendPointers pointers = {};
    if (!ReadSendPointers(wrapper, &pointers)) return;
    nlohmann::json row = BuildRow("send", pointers.owner, base, 0x10);
    row["bodyOffset"] = static_cast<unsigned long long>(pointers.body - pointers.owner);
    RawScan scan = {};
    CaptureRange(parameters, base, 0x100, 0x100, &scan);
    row["params"] = RawJson(scan);
    PushRow(std::move(row));
}

uintptr_t TracedDispatch(uintptr_t context, uintptr_t out, uintptr_t vector, bool flag) {
    try {
        Observe(vector);
    } catch (...) {
    }
    return original(context, out, vector, flag);
}

uintptr_t TracedSend(uintptr_t wrapper, uintptr_t parameters) {
    try {
        ObserveSend(wrapper, parameters);
    } catch (...) {
    }
    return originalSend(wrapper, parameters);
}
} // namespace

bool StartTrace(unsigned seconds) {
    std::lock_guard<std::mutex> lock(traceMutex);
    if (!original || !originalSend) {
        auto base = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
        if (!base) return false;
        auto status = MH_Initialize();
        if (status != MH_OK && status != MH_ERROR_ALREADY_INITIALIZED) return false;
        if (!original) {
            auto address = reinterpret_cast<void*>(base + Dispatch);
            if (MH_CreateHook(address, reinterpret_cast<void*>(TracedDispatch),
                              reinterpret_cast<void**>(&original)) != MH_OK) {
                return false;
            }
            if (MH_EnableHook(address) != MH_OK) {
                MH_RemoveHook(address);
                original = nullptr;
                return false;
            }
        }
        if (!originalSend) {
            auto address = reinterpret_cast<void*>(base + SendMessage);
            if (MH_CreateHook(address, reinterpret_cast<void*>(TracedSend),
                              reinterpret_cast<void**>(&originalSend)) != MH_OK) {
                return false;
            }
            if (MH_EnableHook(address) != MH_OK) {
                MH_RemoveHook(address);
                originalSend = nullptr;
                return false;
            }
        }
    }
    armed = true;
    expires = GetTickCount64() + static_cast<ULONGLONG>(seconds ? seconds : 120) * 1000ULL;
    rows.clear();
    return true;
}

std::string TraceJson() {
    std::lock_guard<std::mutex> lock(traceMutex);
    nlohmann::json body = {
        {"active", armed && GetTickCount64() <= expires},
        {"rows", rows},
    };
    try {
        return body.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
    } catch (...) {
        return "{\"active\":false,\"rows\":[],\"error\":\"dump failed\"}";
    }
}
} // namespace WeChatAgentVoiceTrace
