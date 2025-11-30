# ------ INSTALACIÓN FFMPEG v4 ------
apt-get update && apt-get upgrade -y
apt-get install git -y
mkdir /root/installing
cd /root/installing
git clone https://github.com/FFmpeg/FFmpeg.git
cd FFmpeg/
git checkout n4.4.6 

apt-get update -qq && apt-get -y install \
  autoconf \
  automake \
  build-essential \
  cmake \
  git-core \
  libass-dev \
  libfreetype6-dev \
  libgnutls28-dev \
  libmp3lame-dev \
  libsdl2-dev \
  libtool \
  libva-dev \
  libvdpau-dev \
  libvorbis-dev \
  libxcb1-dev \
  libxcb-shm0-dev \
  libxcb-xfixes0-dev \
  meson \
  ninja-build \
  pkg-config \
  texinfo \
  wget \
  yasm \
  zlib1g-dev

mkdir -p ~/ffmpeg_sources ~/bin

apt-get install nasm -y
apt-get install libx264-dev -y
apt-get install libx265-dev libnuma-dev -y
apt-get install libvpx-dev -y
apt-get install libopus-dev -y
apt-get install libunistring-dev -y


cd ~/ffmpeg_sources && \
git -C aom pull 2> /dev/null || git clone --depth 1 https://aomedia.googlesource.com/aom && \
mkdir -p aom_build && \
cd aom_build && \
PATH="$HOME/bin:$PATH" cmake -G "Unix Makefiles" -DCMAKE_INSTALL_PREFIX="$HOME/ffmpeg_build" -DENABLE_TESTS=OFF -DENABLE_NASM=on ../aom && \
PATH="$HOME/bin:$PATH" make -j$(nproc) && \
make -j$(nproc) install

cd ~/'ffmpeg_sources' &&
git clone 'https://github.com/Netflix/vmaf' 'vmaf-master' &&
mkdir -p 'vmaf-master/libvmaf/build' &&
cd 'vmaf-master/libvmaf/build' &&
meson setup -Denable_tests=false -Denable_docs=false --buildtype=release --default-library=static '../' --prefix "$HOME/ffmpeg_build" --bindir="$HOME/bin" --libdir="$HOME/ffmpeg_build/lib" &&
ninja -j$(nproc) &&
ninja -j$(nproc) install;

cp -av /root/installing/FFmpeg/. /root/ffmpeg_sources/ffmpeg
cd ~/ffmpeg_sources/ffmpeg

PATH="$HOME/bin:$PATH" PKG_CONFIG_PATH="$HOME/ffmpeg_build/lib/pkgconfig" ./configure \
  --prefix="$HOME/ffmpeg_build" \
  --pkg-config-flags="--static" \
  --extra-cflags="-I$HOME/ffmpeg_build/include" \
  --extra-ldflags="-L$HOME/ffmpeg_build/lib" \
  --extra-libs="-lpthread -lm" \
  --ld="g++" \
  --bindir="$HOME/bin" \
  --enable-gpl \
  --enable-gnutls \
  --enable-libaom \
  --enable-libass \
  --enable-libfreetype \
  --enable-libmp3lame \
  --enable-libopus \
  --enable-libvorbis \
  --enable-libvpx \
  --enable-libx264 \
  --enable-libx265 \
  --enable-nonfree && \
PATH="$HOME/bin:$PATH" make -j$(nproc) && \
make -j$(nproc) install && \
hash -r

source ~/.profile

cd /root/ffmpeg_sources/ffmpeg

cp -r /root/bin/. /usr/local/bin
cp -r /root/ffmpeg_build/lib/. /usr/local/lib
cp -r /root/ffmpeg_build/include/. /usr/local/include

# ------ INSTALACIÓN FFMPEG_DEBUG_QP ------
cd /root/installing
git clone https://github.com/slhck/ffmpeg-debug-qp.git
cd ffmpeg-debug-qp
make -j$(nproc)
cp /root/installing/ffmpeg-debug-qp/ffmpeg_debug_qp /usr/local/bin/

# ------ INSTALACIÓN QoE SERVER ------
cd /root
mkdir Developer
cd Developer
git clone https://gitlab.com/comm/videoai/qoe-estimation-server.git
cd qoe-estimation-server
apt install python3.11-venv
python3 -m venv venv
source ./venv/bin/activate
pip3 install git+https://github.com/itu-p1203/itu-p1203
pip install -r requirements.txt
python3 -m flask run --host=0.0.0.0

