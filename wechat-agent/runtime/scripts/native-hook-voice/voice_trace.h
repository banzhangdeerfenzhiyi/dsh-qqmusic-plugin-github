#pragma once
#include <cstdint>
#include <string>

namespace WeChatAgentVoiceTrace {
    // The in-process dispatch used by outgoing sticker/file sends. It has not
    // been observed to carry voice sends, so it is kept as one of two probes.
    inline constexpr uintptr_t Dispatch = 0x16BED80;
    // The final send call every native outgoing message funnels through
    // (offset::send_message in the upstream hook). This is the reliable probe.
    inline constexpr uintptr_t SendMessage = 0x1677A30;
    bool StartTrace(unsigned seconds);
    std::string TraceJson();
}
