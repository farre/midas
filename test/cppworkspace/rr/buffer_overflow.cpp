#include <iostream>
#include <cstddef>
#include <istream>
#include <string>

struct StringView {
  const char* str;
  std::size_t len;
  StringView(const char* string) noexcept : str(string), len(0) {
    if(string == nullptr) {
      return;
    }
    for(auto it = str; *it != '\0'; it++) {
      len++;
    }
  }

  // this function is meant to do weird ish (like make future calls to string view segfault)
  void remove_prefix(std::size_t new_start) {  
    for(; new_start > 0; new_start--) {
      str++;
      this->len--;
    }
  }
  const char* get() const { return str; }
};

void use_ptr(int *ptr) { std::cout << "value: " << *ptr << std::endl; }

int main() {

  std::string danger_danger{"hello world"};
  StringView view{danger_danger.data()};
  StringView* p = &view;
  std::cout << p->get() << std::endl;
  p->remove_prefix(10);
  std::cout << p->get() << std::endl;
  p->remove_prefix(5);
  // boom
  std::cout << p->get() << std::endl;
}