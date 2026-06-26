import platform

from stupidex.domain.message import Message, MessageRole, MessageType


def build_static_system_prompt(system_prompt: str) -> Message:
    content = f"""
    <instructions>
    {system_prompt}
    </instructions>

    <user_operating_system>{_get_os_info()}</user_operating_system>
    """

    return Message(
        role=MessageRole.SYSTEM,
        content=content,
        type=MessageType.TEXT,
    )


def _get_os_info() -> str:
    system = platform.system()
    machine = platform.machine()

    if system == "Windows":
        win_ver = platform.win32_ver()
        return f"Windows {win_ver[0]} (build {win_ver[1]}, {machine})"

    if system == "Darwin":
        mac_ver = platform.mac_ver()
        return f"macOS {mac_ver[0]} ({machine})"

    if system == "Linux":
        try:
            info = platform.freedesktop_os_release()
            distro = f"{info.get('NAME', 'Unknown')} {info.get('VERSION_ID', '')}".strip(
            )
        except (OSError, AttributeError):
            distro = "Unknown"
        kernel = platform.release()
        return f"Linux {distro} (kernel {kernel}, {machine})"

    return f"{system} {platform.release()} ({machine})"
