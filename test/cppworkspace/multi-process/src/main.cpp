#include <iostream>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cstdlib>

int main() {
    pid_t pid = fork(); // Create a child process

    if (pid < 0) {
        std::cerr << "Fork failed!" << std::endl;
        return 1;
    }

    if (pid == 0) {
        // Child process
        std::cout << "Child process (PID: " << getpid() << ") executing ls_program..." << std::endl;

        // Use exec to run the second application
        execl("/home/prometheus/dev/midas/test/cppworkspace/bin/listdir", "/home/prometheus/dev/midas/test/cppworkspace/bin/listdir", nullptr);

        // If execl fails
        perror("execl failed");
        return 1;
    } else {
        // Parent process
        std::cout << "Parent process (PID: " << getpid() << "), waiting for child..." << std::endl;
        wait(nullptr); // Wait for the child process to complete
        std::cout << "Child process finished." << std::endl;
    }

    return 0;
}