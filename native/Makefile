# 构建讯飞离线 TTS 命令行封装（Linux x64 + gcc）
#
#   npm run tts:build          # 等价于 make -C native
#
# 产物：runtime/tts/bin/xf-tts，运行时通过 $ORIGIN/../lib 找到 libmsc.so，
# 不依赖调用方的 LD_LIBRARY_PATH（服务里仍会显式再加一次，双保险）。

CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -std=c11

HERE := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
TTS := $(HERE)/../runtime/tts
LIBDIR := $(TTS)/lib
BIN := $(TTS)/bin/xf-tts
SRC := $(HERE)/xf_tts.c

.PHONY: all clean check

all: $(BIN)

$(BIN): $(SRC) | $(LIBDIR)/libmsc.so
	@mkdir -p $(TTS)/bin
	$(CC) $(CFLAGS) -o $@ $(SRC) \
		-L$(LIBDIR) -lmsc \
		-Wl,-rpath,'$$ORIGIN/../lib' \
		-lpthread -ldl -lm
	@echo "构建完成: $(BIN)"

$(LIBDIR)/libmsc.so:
	@echo "缺少 $(LIBDIR)/libmsc.so：先执行 npm run tts:setup（从旧系统目录复制 SDK）" >&2
	@exit 1

check: $(BIN)
	@echo "==> 动态库依赖"
	@ldd $(BIN) || true
	@echo "==> 版本自述"
	@$(BIN) --help

clean:
	@rm -f $(BIN)
	@echo "已删除 $(BIN)"
