#include <iostream>

void use_ptrs(int *ptr, std::size_t len) {
  auto index = 0;
  for (; len > 0; --len) {
    const auto value = *ptr;
    std::cout << "value: #" << index << ": " << value << std::endl;
    ++index;
    ++ptr;
  }
}

int main() {
  int **values = new int *[2];
  auto iota = [cnt = 0](int *v, std::size_t len) mutable {
    while (len > 0) {
      *v = cnt;
      cnt++;
      len--;
      v++;
    }
  };

  values[0] = new int[10];
  iota(values[0], 10);
  values[1] = nullptr;
  use_ptrs(values[0], 10);
  use_ptrs(values[1], 10);
}