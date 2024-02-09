#include "testcase_namespaces/baseclasses.hpp"
#include "testcase_namespaces/derive.hpp"
#include "testcase_namespaces/enum.hpp"
#include "testcase_namespaces/exceptions.hpp"
#include "testcase_namespaces/longstack.hpp"
#include "testcase_namespaces/pp.hpp"
#include "testcase_namespaces/statics.hpp"
#include "testcase_namespaces/structrequests.hpp"
#include "testcase_namespaces/test_freefloating_watch.hpp"
#include "testcase_namespaces/test_ptrs.hpp"
#include <cstdint>
#include <iostream>
#include <iterator>
#include <map>
#include <number.hpp>
#include <string>
#include <vector>

#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <signal.h>

#include <string.hpp>
#include <vector.hpp>

// Singly linked list node mixin
template <typename T> struct intrusive_list_node { T *next = nullptr; };

int overload(int a) { return a * 2; }
float overload(float a) { return a * 2.0f; }
double overload(double a) { return a * 2.0; }

template <IsNumber Num> Number<Num> add_two(Num a, Num b) {
  Number l{a};
  Number r{b};
  return Number<Num>::sum(l, r);
}

struct S {
  int j;
  int k;
};

struct T : intrusive_list_node<T> {
  S s;
  float f;
};

struct Ts {
  T *ts;
};

void doFooBar() {
  S fooBar{.j = 10, .k = 100};
  fooBar.j += 1;
}

void interrupt_signal(int sig) {
  printf("<------- INTERRUPT ------->:  %d\n", sig);
  printf(" handler exit ");
}

void testRValueReferences(std::string &&item) {
  auto result = item;
  std::cout << "item is: " << result;
}

// test case for inlined functions and breakpoints set on them.
inline void alter_t(T &t) {
  t.f++;
  t.s.j++;
  t.s.k++;
}

struct FooBarBaz {
  int a, b, c;
};

struct Builder {
  Builder() {}

  Builder& set_foo(int f) {
    foo = f;
    return *this;
  }

  Builder& set_bar(int b) {
    bar = b;
    return *this;
  }

  Builder& set_baz(int b) {
    baz = b;
    return *this;
  }

  FooBarBaz finalize() {
    return FooBarBaz { .a = foo, .b = bar, .c = baz };
  }

private:
  int foo;
  int bar;
  int baz;
};

struct ZeroedUint8Memory {
  ZeroedUint8Memory(int size) : items(size) {
    elements = new uint8_t[items];
    int_elements = new int[items];
    int j = 0;
    for(auto i = 0; i < size; i++) {
      elements[i] = i;
      int_elements[i] = i * 10;
    }
  }

  ~ZeroedUint8Memory() {
    delete[] this->int_elements;
    delete[] this->elements;
  }

  int items;
  uint8_t* elements;
  int* int_elements;
};

void zeroed_test(int foo, float bar) {
  auto u8mem = ZeroedUint8Memory(32);
  auto u8mem_ptr = new ZeroedUint8Memory(64);
  auto ref_to_ptr = &u8mem_ptr;
  std::cout << "exiting zeroed_test" << std::endl;
}

std::vector<int> create_vector() {
  std::vector<int> result;
  result.reserve(10000);
  for(auto i = 0; i < 10000; i++) result.push_back(i);
  return result;
}

std::vector<std::string> create_string_vector(int size) {
  std::vector<std::string> result;
  result.reserve(size);
  for(auto i = 0; i < size; i++) result.push_back(std::to_string(i));
  return result;
}

void fill_vector(Vector<String>& v) {
  for(auto i = 0; i < 10000; i++) v.push(std::to_string(i));
}

void vec_str() {
  Vector<String> v{};
  v.reserve(10000);
  fill_vector(v);
  String str{"hello world, do you see me now?"};
  std::cout << "Many strings filled";
}

void stdvec_str() {
  std::vector<String> v{};
  v.reserve(10000);
  for(auto i = 0; i < 10000; i++) v.push_back(std::to_string(i));
  std::cout << "Many strings filled" << std::endl;
}

void vec_stdstr() {
  Vector<std::string> v{};
  v.reserve(10000);
  for(auto i = 0; i < 10000; i++) v.push(std::to_string(i));
  std::cout << "Many strings filled" << std::endl;
}

void stdstr_stdvector() {
  std::vector<std::string> v{};
  v.reserve(10000);
  for(auto i = 0; i < 10000; i++) v.push_back(std::to_string(i));
  std::cout << "Many strings filled" << std::endl;
}

void test_pps() {
  vec_str();
  stdvec_str();
  vec_stdstr();
  stdstr_stdvector();
}

void stringfuckup() {
  std::string foo = "check this out ya bish";
  auto strs = create_string_vector(12000);
  std::cout << "many strs" << strs.size();
}

void use_string() {
  std::string foostring{"foobarbaz asadasdasasdsadasd"};
  std::cout << "string yo" << std::endl;
}

void use_cstring() {
  const char* str = "foo bar yo?";
  std::cout << "attempting to use string: " << str << std::endl;
}

void many_ints() {
  const auto ints = create_vector();
  std::cout << "many ints" << std::endl;
}

int simple_foo(int a, float b) {
  int j = static_cast<int>(static_cast<float>(a) * b);
  return j;
}

struct Foo {
  int a = 10;
  int b = 20;
};

struct Bar_ {
  Foo foo;
  int bar = 30;
};

struct Quux {
  int a, b;
  const Foo& foo_ref;
  int array[3];
};

int main(int argc, const char **argv) {
  simple_foo(10, 11.1);
  test_pps();
  stringfuckup();
  use_string();
  use_cstring();
  many_ints();
  Foo foo_{};
  // test that the DAP implementation returns correct (at least from user perspective) values in
  // variables & watch variables list
  Quux q{.a = 1, .b = 2, .foo_ref = foo_, .array = {9, 8, 7}};
  Bar_ ba{};
  std::string foostring{"foobarbaz asadasdasasdsadasd"};
  std::map<int, std::string> mumbojumbo{};
  std::vector<std::string> strings_2{};
  int arr[3]{10000, 20000, 30000};
  const auto integers = create_vector();
  strings_2.reserve(10);
  strings_2.emplace_back("hello");
  strings_2.emplace_back("world");
  strings_2.emplace_back("goodbye");
  strings_2.emplace_back("universe");
  strings_2.emplace_back("!");

  signal(SIGTERM, interrupt_signal);
  raise(SIGTERM);

  const auto ref = strings_2[2];

  mumbojumbo[10] = "hello";
  mumbojumbo[1337] = "world";
  mumbojumbo[9] = "main";
  mumbojumbo[23] = "foo()";
  mumbojumbo[19] = "bar()";
  mumbojumbo[190] = "check()";

  // Do we trigger acc wp?
  const auto _main = mumbojumbo[9];
  std::vector<std::string> foos[3]{};
  // testing for pretty printed child values of pretty printed type behind a pointer
  auto foovec = new std::vector<std::string>{};
  auto sz = 128;
  auto u8mem = ZeroedUint8Memory(sz);
  auto u8mem_heap = new ZeroedUint8Memory{sz};
  
  zeroed_test(10, 42.0f);
  for(auto i = 0; i < sz; i++) {
    u8mem.elements[i] = i;
    u8mem_heap->elements[i] = i;
  }

  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  []() {
    const auto strings = create_string_vector(10000);
    std::cout << "many strings: " << strings.size();
  }();
  std::cout << "Goodbye cruel world" << std::endl;
  prettyprinting::main();
  test_ptrs_main();
  enum_stuff();
  derive::main();
  baseclasses::main();
  longstack::main();
  statics::main();
  structsrequests::main();
  freefloating_watch::main();

  Builder b;
  const auto fbb = b.set_foo(10)
                      .set_bar(20)
                      .set_baz(30)
                      .finalize();

  Builder b2;
  const auto inline_fbb = b2.set_foo(10).set_bar(20).set_baz(30).finalize();

  exceptions::main(9);
  exceptions::main(4);
}