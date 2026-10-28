#pragma once
#include <cstdint>
#include <string>

namespace WeChatAgentVoice {
    // Static facts reviewed against the bundled 4.1.10.27 PE (see find_voice_*):
    //   0x619A190  allocates the 0x778-byte voice message object (owner vtable
    //              0x8DCFF98), embeds a body at owner+0x10 (vtable 0x8DD0028)
    //              and fills: target string at body+0xB0, SILK bytes as a
    //              std::string at body+0x708, duration at body+0x728 and a
    //              voice-format block at body+0x730.
    //   0x1677A30  the common send call shared with text/image/file/sticker.
    inline constexpr uintptr_t Factory = 0x619A190;
    inline constexpr uintptr_t SendMessage = 0x1677A30;
    inline constexpr unsigned MessageTypeVoice = 0x22;
    bool Ready();
    // Send one SILK (Tencent silk v3, with header) voice message.
    bool Send(const std::string& target, const std::string& silkPath, unsigned durationMs);
}
