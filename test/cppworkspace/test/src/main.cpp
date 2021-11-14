#include <iostream>
#include <vector>

#include <number.hpp>
#include <todo.hpp>

int overload(int a) { return a * 2; }
float overload(float a) { return a * 2.0f; }
double overload(double a) { return a * 2.0; }

template <IsNumber Num> Number<Num> add_two(Num a, Num b) {
  Number l{a};
  Number r{b};
  return Number<Num>::sum(l, r);
}

int main(int argc, const char **argv) {
  const auto somelocal = 42;
  Todo tmp{"Test local struct", Date{.day = 3, .month = 11, .year = 2021}};
  auto Double = add_two(1.550795, 1.590795);
  auto Float = add_two(668.19685f, 668.93685f);
  auto Int = add_two(20, 22);

  std::cout << "Value of " << Double << std::endl;
  std::cout << "Value of " << Float << std::endl;
  std::cout << "Value of " << Int << std::endl;

  int ol1 = overload(1);
  float ol2 = overload(2.0f);
  double ol3 = overload(3.0);

  std::vector<Todo> todos{};
  todos.push_back(Todo{"Make test app for debugger extension",
                       Date{.day = 3, .month = 11, .year = 2021}});
  todos.push_back(Todo{"Read code-debug & look for useful stuff",
                       Date{.day = 4, .month = 11, .year = 2021}});
  todos.push_back(Todo{"Read vscode-mock-debug & rip out things of use",
                       Date{.day = 5, .month = 11, .year = 2021}});

  std::cout << "Things to do: " << Todo::todo_count() << std::endl;
  for (const auto &t : todos) {
    std::cout << "\tTodo id " << t.id() << ": " << t.title() << " @" << t.date()
              << std::endl;
  }
  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  std::cout << "Goodbye cruel world" << std::endl;
}
