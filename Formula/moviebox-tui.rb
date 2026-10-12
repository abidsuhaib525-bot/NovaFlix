class MovieboxTui < Formula
  VERSION = "0.1.26"
  MACOS_SHA256 = "8d7fd8e578d8b0cf0e0e94514c0201f9b433154d2afd7b45cefae2d093f6d3ab"
  LINUX_X64_SHA256 = "3582aa63ce87d650f7953d87c65248d4181d808197b85a49080ebf774d5bfa6c"
  LINUX_ARM64_SHA256 = "1970397242bdc5d540cdc30469e3b1ba012b25f5ff9d3755040973adb13cb872"

  desc "Stream movies, shows, anime, and live TV from your terminal"
  homepage "https://github.com/mesamirh/MovieBox-Tui"
  version VERSION
  license any_of: ["MIT", "Apache-2.0"]

  on_macos do
    url "https://github.com/mesamirh/MovieBox-Tui/releases/download/v#{VERSION}/MovieBox_macOS_Universal.tar.gz"
    sha256 MACOS_SHA256
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/mesamirh/MovieBox-Tui/releases/download/v#{VERSION}/MovieBox_Linux_arm64.tar.gz"
      sha256 LINUX_ARM64_SHA256
    else
      url "https://github.com/mesamirh/MovieBox-Tui/releases/download/v#{VERSION}/MovieBox_Linux_x64.tar.gz"
      sha256 LINUX_X64_SHA256
    end
  end

  def install
    bin.install "moviebox-tui"
  end

  test do
    system "#{bin}/moviebox-tui", "--version"
  end
end
