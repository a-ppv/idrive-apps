// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test (Linux: the control socket's accept4) for the service on a head
 * unit that refuses it (refused.h). */
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <cerrno>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "config.h"
#include "control.h"
#include "log.h"
#include "refused.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond, const std::string &detail = "")
{
    std::printf("%-4s %s%s%s\n", cond ? "ok" : "FAIL", name, cond || detail.empty() ? "" : ": ", cond ? "" : detail.c_str());
    if (!cond)
        failures++;
}

static std::string sock;

static int connect_to()
{
    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr;
    std::memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    std::snprintf(addr.sun_path, sizeof addr.sun_path, "%s", sock.c_str());
    for (int i = 0; i < 100 && connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0; i++)
        usleep(20000);
    struct timeval tv = {1, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    return fd;
}

/* What the socket says within a second. */
static std::string hear(int fd)
{
    std::string in;
    char buf[4096];
    for (ssize_t n; (n = read(fd, buf, sizeof buf)) > 0;)
        in.append(buf, (size_t)n);
    return in;
}

int main()
{
    char tmpl[] = "/tmp/woc-refused-XXXXXX";
    if (!mkdtemp(tmpl))
        return 1;
    const std::string dir = tmpl;
    sock = dir + "/ctl.sock";
    const std::string why = "head unit: unknown variant is not supported (no hwvariant= on the kernel command line)";
    /* The cluster renderer's socket, with the HUD on: nothing may reach it. */
    const std::string render = dir + "/render.sock";
    const int rfd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    struct sockaddr_un raddr;
    std::memset(&raddr, 0, sizeof raddr);
    raddr.sun_family = AF_UNIX;
    std::snprintf(raddr.sun_path, sizeof raddr.sun_path, "%s", render.c_str());
    const bool listening = bind(rfd, (struct sockaddr *)&raddr, sizeof raddr) == 0 && listen(rfd, 4) == 0;
    const pid_t pid = fork();
    if (pid == 0) {
        cld::Config cfg;
        cfg.define("fifo_path", "");
        cfg.define("log_file", "");
        cfg.define("log_file_kb", "512");
        std::string err;
        cfg.set_pair(("fifo_path=" + dir + "/alt.h264").c_str(), &err);
        cfg.set_pair(("socket_path=" + sock).c_str(), &err);
        cfg.set_pair("socket_group=", &err);
        cfg.set_pair(("render_socket=" + render).c_str(), &err);
        cfg.set_pair("hud=1", &err);
        _exit(serve_refused(cfg, why));
    }

    const int owner = connect_to();
    const std::string first = hear(owner);
    std::map<std::string, std::string> st;
    ok("the owner gets one status line, and nothing more", first == refused_status(why) + "\n", first);
    ok("unsupported, not supported on this car, the turn box greyed",
       parse_flat_json(refused_status(why), &st) && st["state"] == "unsupported" &&
           st["reason"] == "Unavailable" && st["refused"] == "not supported on this car (head unit: unknown variant is not supported (no hwvariant= on the kernel command line))" &&
           st["guide_disabled"] == "1" &&
           !st.count("hide_bmw_guidance") && !st.count("hud"));
    const std::string guide = "{\"cmd\":\"guide\",\"hide\":0}\n{\"cmd\":\"start\",\"target\":\"map\"}\n"
                              "{\"cmd\":\"hud\",\"on\":\"1\"}\n";
    ok("commands are taken without an answer", write(owner, guide.data(), guide.size()) == (ssize_t)guide.size() &&
       hear(owner).empty());
    const int second = connect_to();
    ok("a second connection is told busy", hear(second).find("\"reason\":\"busy\"") != std::string::npos);
    close(second);
    std::stringstream status;
    status << std::ifstream(dir + "/status.json").rdbuf();
    ok("status.json says the same", status.str() == refused_status(why) + "\n", status.str());
    close(owner);
    const int again = connect_to();
    ok("the next owner gets the status too", hear(again) == refused_status(why) + "\n");
    close(again);
    ok("with the HUD on and asked for, nothing connects to the cluster renderer",
       listening && accept(rfd, nullptr, nullptr) < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
    close(rfd);
    int code = -1;
    ok("still up", waitpid(pid, &code, WNOHANG) == 0);
    kill(pid, SIGTERM);
    ok("a SIGTERM ends it with 0", waitpid(pid, &code, 0) == pid && WIFEXITED(code) && WEXITSTATUS(code) == 0);
    if (std::system(("rm -rf '" + dir + "'").c_str()) != 0)
        std::printf("     could not remove %s\n", dir.c_str());
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
