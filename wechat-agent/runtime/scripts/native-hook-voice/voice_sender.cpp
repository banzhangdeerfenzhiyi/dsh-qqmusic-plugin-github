// Native WeChat voice-message sender for the 4.1.10.27 client.
//
// The client's own voice pipeline builds the outgoing message with
//   0x619A190(outPair, targetWxid*, silkString*, durationPtr*, voiceInfo*)
// which allocates the 0x778-byte object, initializes both vtables and copies:
//   body+0x0B0  target wxid            (std::string, arg 2)
//   body+0x708  SILK bytes             (std::string, arg 3)
//   body+0x728  duration in ms         (uint32,     arg 4)
//   body+0x730  voice format block     (16 bytes + std::string, arg 5)
// The caller (0x6199D10) then stamps body+0xD8 = 0x22 (voice) before enqueueing.
//
// This sender reuses the same factory + the common send call the file/sticker
// senders already use, so the upload/enqueue path stays WeChat's own.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include "global.h"
#include "voice_sender.h"

namespace WeixinSend {
    struct InnerStruct2;
    InnerStruct2* BuildSendParam1(uint64_t);
    void BuildSendParam2_Image(uint64_t*);
}

namespace WeChatAgentVoice {
namespace {
struct OutPair {
    void* body;
    void* owner;
};

// Matches the layout the body constructor reads from the fifth factory argument.
struct VoiceInfo {
    int32_t a;       // observed 4
    int32_t b;       // observed 3
    int32_t c;       // observed 30000
    int32_t pad;
    uint8_t flag;    // observed 0
    uint8_t flagPad[7];
    std::string text; // observed empty on real recordings
};
} // namespace

bool Ready() {
    auto module = GetModuleHandleW(L"Weixin.dll");
    if (!module) return false;
    auto base = reinterpret_cast<uintptr_t>(module);
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
    const auto* pe = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    if (pe->Signature != IMAGE_NT_SIGNATURE) return false;
    auto executable = [base, pe](uintptr_t rva) {
        if (rva >= pe->OptionalHeader.SizeOfImage) return false;
        MEMORY_BASIC_INFORMATION info{};
        return VirtualQuery(reinterpret_cast<void*>(base + rva), &info, sizeof(info)) == sizeof(info) &&
               info.State == MEM_COMMIT &&
               (info.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY));
    };
    if (!executable(Factory) || !executable(SendMessage)) return false;
    // The reviewed build starts with push rbp / push r15 / push r14 / push r12.
    const unsigned char prologue[] = {0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x54};
    return memcmp(reinterpret_cast<void*>(base + Factory), prologue, sizeof(prologue)) == 0;
}

bool Send(const std::string& target, const std::string& silkPath, unsigned durationMs) {
    if (!Ready()) return false;
    // The caller only ever passes ASCII paths under state/voice/outgoing.
    std::ifstream file(std::filesystem::path(silkPath), std::ios::binary);
    if (!file) return false;
    std::string silk((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (silk.size() < 10 || silk.size() > 8 * 1024 * 1024) return false;
    // Tencent SILK v3 header: 0x02 '#!SILK_V3'
    if (static_cast<unsigned char>(silk[0]) != 0x02 || silk.compare(1, 9, "#!SILK_V3") != 0) return false;

    auto base = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));
    std::string targetCopy = target;
    int32_t duration = static_cast<int32_t>(durationMs);
    VoiceInfo info{};
    info.a = 4;
    info.b = 3;
    info.c = 30000;
    info.flag = 0;

    OutPair pair{};
    using FactoryFn = OutPair*(*)(OutPair*, void*, void*, void*, void*);
    reinterpret_cast<FactoryFn>(base + Factory)(&pair, &targetCopy, &silk, &duration, &info);
    if (!pair.body || !pair.owner) return false;
    // Stamp the message type exactly where the client's own caller does.
    *reinterpret_cast<uint32_t*>(reinterpret_cast<char*>(pair.body) + 0xD8) = MessageTypeVoice;

    auto first = WeixinSend::BuildSendParam1(reinterpret_cast<uint64_t>(pair.owner));
    auto second = static_cast<uint64_t*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0xE8));
    if (!first || !second) return false;
    WeixinSend::BuildSendParam2_Image(second);
    using Dispatch = __int64(*)(uint64_t, uint64_t);
    reinterpret_cast<Dispatch>(base + SendMessage)(reinterpret_cast<uint64_t>(first), reinterpret_cast<uint64_t>(second));
    // Native acceptance only; the reader confirms the outgoing voice message.
    return true;
}
} // namespace WeChatAgentVoice
