#include <csignal>
#include <string>
#include <iostream>
#include <thread>
#include <chrono>
#include <unistd.h>

int main(int argc, const char** argv) {
  std::cout << "Hello world" << std::endl;
  auto pid = getpid();
  std::cout << pid << std::endl;
  // let's interrupt here, so that we are given time to attach with gdb
  std::string buf;
  while(true) {
    std::cout << "input: (waiting for q to quit):";
    std::getline(std::cin, buf);
    std::cout << "read: " << buf << std::endl;
    if(buf == "q") {
      break;
    }
  }
  std::cout << "swoosh" << std::endl;
}
